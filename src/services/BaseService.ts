import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createLogger, Logger } from '@/utils/logger';
import { ServiceConfig, HealthStatus } from '@/types';
import { db } from '@/utils/database';
import { redis } from '@/utils/redis';
import { messageQueue } from '@/utils/messageQueue';
import { Config } from '@/config';

export abstract class BaseService {
  protected app: Express;
  protected logger: Logger;
  protected config: ServiceConfig;
  protected server: any;
  protected isRunning: boolean = false;
  protected startTime: Date = new Date();

  constructor(serviceName: string) {
    this.config = Config.getServiceConfig(serviceName);
    this.logger = createLogger(serviceName);
    this.app = express();
    
    this.setupMiddleware();
    this.setupHealthRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req: Request, res: Response, next) => {
      this.logger.debug(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });

    // Error handling
    this.app.use((error: Error, req: Request, res: Response, next: any) => {
      this.logger.error('Request error', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: Date.now()
      });
    });
  }

  private setupHealthRoutes(): void {
    this.app.get('/health', async (req: Request, res: Response) => {
      const health = await this.getHealthStatus();
      const statusCode = health.status === 'HEALTHY' ? 200 : 503;
      res.status(statusCode).json(health);
    });

    this.app.get('/metrics', async (req: Request, res: Response) => {
      const metrics = await this.getMetrics();
      res.json(metrics);
    });
  }

  public async start(): Promise<void> {
    try {
      // Initialize dependencies
      await this.initializeDependencies();

      // Initialize service-specific setup
      await this.initialize();

      // Start HTTP server
      this.server = this.app.listen(this.config.port, () => {
        this.isRunning = true;
        this.logger.info(`${this.config.name} started on port ${this.config.port}`);
      });

      // Setup graceful shutdown
      process.on('SIGINT', () => this.gracefulShutdown());
      process.on('SIGTERM', () => this.gracefulShutdown());

    } catch (error) {
      this.logger.error('Failed to start service', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;

      // Stop HTTP server
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server.close(() => resolve());
        });
      }

      // Cleanup service-specific resources
      await this.cleanup();

      this.logger.info(`${this.config.name} stopped`);
    } catch (error) {
      this.logger.error('Error stopping service', error);
      throw error;
    }
  }

  private async initializeDependencies(): Promise<void> {
    const dependencies = this.config.dependencies;

    if (dependencies.includes('postgres')) {
      await db.connect();
      this.logger.info('Database connection established');
    }

    if (dependencies.includes('redis')) {
      await redis.connect();
      this.logger.info('Redis connection established');
    }

    if (dependencies.includes('rabbitmq')) {
      await messageQueue.connect();
      this.logger.info('RabbitMQ connection established');
    }
  }

  private async gracefulShutdown(): Promise<void> {
    this.logger.info('Received shutdown signal, shutting down gracefully...');
    
    try {
      await this.stop();
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during graceful shutdown', error);
      process.exit(1);
    }
  }

  public async getHealthStatus(): Promise<HealthStatus> {
    const dependencies: Record<string, boolean> = {};

    // Check database
    if (this.config.dependencies.includes('postgres')) {
      dependencies.postgres = await db.healthCheck();
    }

    // Check Redis
    if (this.config.dependencies.includes('redis')) {
      dependencies.redis = await redis.healthCheck();
    }

    // Check RabbitMQ
    if (this.config.dependencies.includes('rabbitmq')) {
      dependencies.rabbitmq = await messageQueue.healthCheck();
    }

    const allDependenciesHealthy = Object.values(dependencies).every(Boolean);
    const status = allDependenciesHealthy ? 'HEALTHY' : 'UNHEALTHY';

    return {
      service: this.config.name,
      status,
      uptime: Date.now() - this.startTime.getTime(),
      lastCheck: new Date(),
      dependencies,
      metrics: await this.getMetrics()
    };
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    return {
      uptime: Date.now() - this.startTime.getTime(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      isRunning: this.isRunning
    };
  }

  // Abstract methods to be implemented by each service
  protected abstract initialize(): Promise<void>;
  protected abstract cleanup(): Promise<void>;

  // Utility method to send standardized API responses
  protected sendResponse(res: Response, success: boolean, data?: any, error?: string): void {
    res.json({
      success,
      data,
      error,
      timestamp: Date.now()
    });
  }

  // Utility method to handle async route handlers
  protected asyncHandler(fn: Function) {
    return (req: Request, res: Response, next: any) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // Utility method to validate request body
  protected validateRequest(schema: any, data: any): { isValid: boolean; errors?: string[] } {
    const { error } = schema.validate(data);
    
    if (error) {
      return {
        isValid: false,
        errors: error.details.map((detail: any) => detail.message)
      };
    }

    return { isValid: true };
  }

  protected getApp(): Express {
    return this.app;
  }

  protected getLogger(): Logger {
    return this.logger;
  }

  protected getConfig(): ServiceConfig {
    return this.config;
  }
}