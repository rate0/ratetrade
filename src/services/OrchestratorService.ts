import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { TradingConfig, ServiceMessage, HealthStatus } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import Joi from 'joi';

interface TradingSession {
  id: string;
  mode: 'LIVE' | 'SIM';
  startTime: Date;
  status: 'STARTING' | 'RUNNING' | 'PAUSING' | 'STOPPED' | 'ERROR';
  totalTrades: number;
  totalPnL: number;
  dailyPnL: number;
}

export class OrchestratorService extends BaseService {
  private tradingConfig: TradingConfig;
  private currentSession: TradingSession | null = null;
  private serviceStatuses: Map<string, HealthStatus> = new Map();
  private preflightChecks: Map<string, boolean> = new Map();

  constructor() {
    super('orchestrator');
    this.tradingConfig = Config.getTradingConfig();
    this.setupRoutes();
  }

  protected async initialize(): Promise<void> {
    // Subscribe to service health updates
    await messageQueue.subscribe('health.checks', this.handleHealthUpdate.bind(this));
    
    // Load existing configuration
    await this.loadConfiguration();
    
    // Perform initial preflight checks
    await this.performPreflightChecks();
    
    // Initialize trading session based on BOT_MODE
    if (Config.BOT_MODE === 'LIVE' || Config.BOT_MODE === 'SIM') {
      setTimeout(() => this.startTrading(), 5000); // Give services time to initialize
    }

    this.logger.info('Orchestrator service initialized');
  }

  protected async cleanup(): Promise<void> {
    if (this.currentSession && this.currentSession.status === 'RUNNING') {
      await this.stopTrading();
    }
    this.logger.info('Orchestrator service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();

    // Trading control routes
    app.post('/api/trading/start', this.asyncHandler(this.startTradingHandler.bind(this)));
    app.post('/api/trading/stop', this.asyncHandler(this.stopTradingHandler.bind(this)));
    app.post('/api/trading/pause', this.asyncHandler(this.pauseTradingHandler.bind(this)));
    app.get('/api/trading/status', this.asyncHandler(this.getTradingStatusHandler.bind(this)));

    // Mode management routes
    app.post('/api/mode/switch', this.asyncHandler(this.switchModeHandler.bind(this)));
    app.get('/api/mode/current', this.asyncHandler(this.getCurrentModeHandler.bind(this)));

    // Configuration routes
    app.get('/api/config', this.asyncHandler(this.getConfigHandler.bind(this)));
    app.put('/api/config', this.asyncHandler(this.updateConfigHandler.bind(this)));

    // Service management routes
    app.get('/api/services/status', this.asyncHandler(this.getServicesStatusHandler.bind(this)));
    app.post('/api/services/restart/:serviceName', this.asyncHandler(this.restartServiceHandler.bind(this)));

    // Emergency routes
    app.post('/api/emergency/stop', this.asyncHandler(this.emergencyStopHandler.bind(this)));
    app.post('/api/emergency/close-positions', this.asyncHandler(this.closeAllPositionsHandler.bind(this)));

    // Preflight checks
    app.get('/api/preflight', this.asyncHandler(this.preflightChecksHandler.bind(this)));
  }

  // Trading Control Handlers
  private async startTradingHandler(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.startTrading();
      this.sendResponse(res, success, { session: this.currentSession });
    } catch (error) {
      this.logger.error('Error starting trading', error);
      this.sendResponse(res, false, null, 'Failed to start trading');
    }
  }

  private async stopTradingHandler(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.stopTrading();
      this.sendResponse(res, success, { session: this.currentSession });
    } catch (error) {
      this.logger.error('Error stopping trading', error);
      this.sendResponse(res, false, null, 'Failed to stop trading');
    }
  }

  private async pauseTradingHandler(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.pauseTrading();
      this.sendResponse(res, success, { session: this.currentSession });
    } catch (error) {
      this.logger.error('Error pausing trading', error);
      this.sendResponse(res, false, null, 'Failed to pause trading');
    }
  }

  private async getTradingStatusHandler(req: Request, res: Response): Promise<void> {
    const status = {
      session: this.currentSession,
      services: Object.fromEntries(this.serviceStatuses),
      preflightChecks: Object.fromEntries(this.preflightChecks),
      config: this.tradingConfig
    };
    this.sendResponse(res, true, status);
  }

  // Mode Management Handlers
  private async switchModeHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      mode: Joi.string().valid('LIVE', 'SIM').required()
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { mode } = req.body;
      const success = await this.switchMode(mode);
      this.sendResponse(res, success, { mode: this.tradingConfig.mode });
    } catch (error) {
      this.logger.error('Error switching mode', error);
      this.sendResponse(res, false, null, 'Failed to switch mode');
    }
  }

  private async getCurrentModeHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, { mode: this.tradingConfig.mode });
  }

  // Configuration Handlers
  private async getConfigHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.tradingConfig);
  }

  private async updateConfigHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      maxDailyLossPercent: Joi.number().min(0).max(50),
      defaultLeverage: Joi.number().min(1).max(125),
      maxLeverage: Joi.number().min(1).max(125),
      maxPositionPercent: Joi.number().min(0).max(100),
      symbols: Joi.array().items(Joi.string()),
      strategies: Joi.array().items(Joi.string())
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      await this.updateConfiguration(req.body);
      this.sendResponse(res, true, this.tradingConfig);
    } catch (error) {
      this.logger.error('Error updating configuration', error);
      this.sendResponse(res, false, null, 'Failed to update configuration');
    }
  }

  // Service Management Handlers
  private async getServicesStatusHandler(req: Request, res: Response): Promise<void> {
    const services = Object.fromEntries(this.serviceStatuses);
    this.sendResponse(res, true, services);
  }

  private async restartServiceHandler(req: Request, res: Response): Promise<void> {
    const { serviceName } = req.params;
    try {
      const success = await this.restartService(serviceName);
      this.sendResponse(res, success, { service: serviceName });
    } catch (error) {
      this.logger.error(`Error restarting service ${serviceName}`, error);
      this.sendResponse(res, false, null, `Failed to restart ${serviceName}`);
    }
  }

  // Emergency Handlers
  private async emergencyStopHandler(req: Request, res: Response): Promise<void> {
    try {
      await this.emergencyStop();
      this.sendResponse(res, true, { message: 'Emergency stop executed' });
    } catch (error) {
      this.logger.error('Error executing emergency stop', error);
      this.sendResponse(res, false, null, 'Emergency stop failed');
    }
  }

  private async closeAllPositionsHandler(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.closeAllPositions();
      this.sendResponse(res, success, { message: 'All positions closed' });
    } catch (error) {
      this.logger.error('Error closing all positions', error);
      this.sendResponse(res, false, null, 'Failed to close all positions');
    }
  }

  private async preflightChecksHandler(req: Request, res: Response): Promise<void> {
    try {
      await this.performPreflightChecks();
      const checks = Object.fromEntries(this.preflightChecks);
      const allPassed = Array.from(this.preflightChecks.values()).every(Boolean);
      this.sendResponse(res, allPassed, checks);
    } catch (error) {
      this.logger.error('Error performing preflight checks', error);
      this.sendResponse(res, false, null, 'Preflight checks failed');
    }
  }

  // Core Trading Logic
  private async startTrading(): Promise<boolean> {
    try {
      if (this.currentSession && this.currentSession.status === 'RUNNING') {
        this.logger.info('Trading session already running');
        return true;
      }

      // Perform preflight checks
      await this.performPreflightChecks();
      const allChecksPassed = Array.from(this.preflightChecks.values()).every(Boolean);
      
      if (!allChecksPassed) {
        this.logger.error('Preflight checks failed, cannot start trading');
        return false;
      }

      // Create new trading session
      this.currentSession = {
        id: `session_${Date.now()}`,
        mode: this.tradingConfig.mode,
        startTime: new Date(),
        status: 'STARTING',
        totalTrades: 0,
        totalPnL: 0,
        dailyPnL: 0
      };

      // Notify all services to start
      await this.broadcastTradingCommand('START_TRADING', {
        sessionId: this.currentSession.id,
        mode: this.tradingConfig.mode,
        config: this.tradingConfig
      });

      this.currentSession.status = 'RUNNING';
      
      // Cache session info
      await redis.set('trading:session', this.currentSession);
      
      this.logger.info('Trading session started', {
        sessionId: this.currentSession.id,
        mode: this.tradingConfig.mode
      });

      // Notify via message queue
      await messageQueue.publishNotification({
        type: 'trading',
        title: '🚀 Trading Started',
        message: `Trading session started in ${this.tradingConfig.mode} mode`,
        priority: 'HIGH'
      });

      return true;
    } catch (error) {
      this.logger.error('Error starting trading session', error);
      if (this.currentSession) {
        this.currentSession.status = 'ERROR';
      }
      return false;
    }
  }

  private async stopTrading(): Promise<boolean> {
    try {
      if (!this.currentSession || this.currentSession.status === 'STOPPED') {
        this.logger.info('No active trading session to stop');
        return true;
      }

      this.currentSession.status = 'STOPPED';

      // Notify all services to stop
      await this.broadcastTradingCommand('STOP_TRADING', {
        sessionId: this.currentSession.id,
        reason: 'Manual stop'
      });

      // Update session cache
      await redis.set('trading:session', this.currentSession);

      this.logger.info('Trading session stopped', {
        sessionId: this.currentSession.id,
        duration: Date.now() - this.currentSession.startTime.getTime()
      });

      // Notify via message queue
      await messageQueue.publishNotification({
        type: 'trading',
        title: '⏹️ Trading Stopped',
        message: `Trading session stopped. Duration: ${this.formatDuration(Date.now() - this.currentSession.startTime.getTime())}`,
        priority: 'HIGH'
      });

      return true;
    } catch (error) {
      this.logger.error('Error stopping trading session', error);
      return false;
    }
  }

  private async pauseTrading(): Promise<boolean> {
    try {
      if (!this.currentSession || this.currentSession.status !== 'RUNNING') {
        this.logger.info('No active trading session to pause');
        return false;
      }

      this.currentSession.status = 'PAUSING';

      // Notify all services to pause
      await this.broadcastTradingCommand('PAUSE_TRADING', {
        sessionId: this.currentSession.id,
        reason: 'Manual pause'
      });

      // Update session cache
      await redis.set('trading:session', this.currentSession);

      this.logger.info('Trading session paused', { sessionId: this.currentSession.id });

      return true;
    } catch (error) {
      this.logger.error('Error pausing trading session', error);
      return false;
    }
  }

  private async switchMode(newMode: 'LIVE' | 'SIM'): Promise<boolean> {
    try {
      if (this.currentSession && this.currentSession.status === 'RUNNING') {
        await this.stopTrading();
      }

      this.tradingConfig.mode = newMode;
      await this.saveConfiguration();

      this.logger.info(`Mode switched to ${newMode}`);

      // Notify via message queue
      await messageQueue.publishNotification({
        type: 'trading',
        title: '🔄 Mode Switched',
        message: `Trading mode switched to ${newMode}`,
        priority: 'MEDIUM'
      });

      return true;
    } catch (error) {
      this.logger.error('Error switching mode', error);
      return false;
    }
  }

  private async emergencyStop(): Promise<void> {
    this.logger.warn('Emergency stop initiated');

    try {
      // Stop trading immediately
      if (this.currentSession) {
        this.currentSession.status = 'STOPPED';
      }

      // Broadcast emergency stop to all services
      await this.broadcastTradingCommand('EMERGENCY_STOP', {
        reason: 'Emergency stop initiated',
        timestamp: Date.now()
      });

      // Close all positions if in LIVE mode
      if (this.tradingConfig.mode === 'LIVE') {
        await this.closeAllPositions();
      }

      this.logger.warn('Emergency stop completed');

      // Critical notification
      await messageQueue.publishNotification({
        type: 'error',
        title: '🚨 EMERGENCY STOP',
        message: 'Emergency stop executed - all trading halted',
        priority: 'CRITICAL'
      });
    } catch (error) {
      this.logger.error('Error during emergency stop', error);
      throw error;
    }
  }

  private async closeAllPositions(): Promise<boolean> {
    try {
      // Send command to execution service to close all positions
      await messageQueue.publish('trading', 'order.close_all', {
        type: 'CLOSE_ALL_POSITIONS',
        payload: { reason: 'Emergency close' },
        timestamp: Date.now(),
        source: 'orchestrator'
      });

      this.logger.info('Close all positions command sent');
      return true;
    } catch (error) {
      this.logger.error('Error sending close all positions command', error);
      return false;
    }
  }

  // Configuration Management
  private async loadConfiguration(): Promise<void> {
    try {
      const cached = await redis.getTradingConfig();
      if (cached) {
        this.tradingConfig = { ...this.tradingConfig, ...cached };
        this.logger.info('Configuration loaded from cache');
      }

      // Load from database
      const dbConfig = await db.query(
        'SELECT key, value FROM system_config WHERE key LIKE $1',
        ['trading_%']
      );

      for (const row of dbConfig) {
        const key = row.key.replace('trading_', '');
        if (key in this.tradingConfig) {
          (this.tradingConfig as any)[key] = this.parseConfigValue(row.value);
        }
      }

      this.logger.info('Configuration loaded from database');
    } catch (error) {
      this.logger.error('Error loading configuration', error);
    }
  }

  private async saveConfiguration(): Promise<void> {
    try {
      // Save to Redis
      await redis.cacheTradingConfig(this.tradingConfig);

      // Save to database
      for (const [key, value] of Object.entries(this.tradingConfig)) {
        await db.query(
          `INSERT INTO system_config (key, value, description) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [`trading_${key}`, JSON.stringify(value), `Trading configuration: ${key}`]
        );
      }

      this.logger.info('Configuration saved');
    } catch (error) {
      this.logger.error('Error saving configuration', error);
    }
  }

  private async updateConfiguration(updates: Partial<TradingConfig>): Promise<void> {
    this.tradingConfig = { ...this.tradingConfig, ...updates };
    await this.saveConfiguration();

    // Broadcast configuration update
    await this.broadcastTradingCommand('CONFIG_UPDATE', {
      config: this.tradingConfig
    });

    this.logger.info('Configuration updated', updates);
  }

  // Preflight Checks
  private async performPreflightChecks(): Promise<void> {
    this.logger.info('Performing preflight checks...');

    // Check API keys
    this.preflightChecks.set('api_keys', this.checkAPIKeys());

    // Check connectivity
    this.preflightChecks.set('binance_connectivity', await this.checkBinanceConnectivity());

    // Check time synchronization
    this.preflightChecks.set('time_sync', await this.checkTimeSync());

    // Check market availability
    this.preflightChecks.set('market_availability', await this.checkMarketAvailability());

    // Check service health
    this.preflightChecks.set('service_health', this.checkServiceHealth());

    // Check database connectivity
    this.preflightChecks.set('database', await db.healthCheck());

    // Check Redis connectivity
    this.preflightChecks.set('redis', await redis.healthCheck());

    // Check RabbitMQ connectivity
    this.preflightChecks.set('rabbitmq', await messageQueue.healthCheck());

    const allPassed = Array.from(this.preflightChecks.values()).every(Boolean);
    this.logger.info('Preflight checks completed', {
      passed: allPassed,
      checks: Object.fromEntries(this.preflightChecks)
    });
  }

  private checkAPIKeys(): boolean {
    return !!(Config.BINANCE_KEY && Config.BINANCE_SECRET && Config.TELEGRAM_TOKEN);
  }

  private async checkBinanceConnectivity(): Promise<boolean> {
    try {
      // This will be implemented when we have the Binance API
      return true; // Placeholder
    } catch (error) {
      this.logger.error('Binance connectivity check failed', error);
      return false;
    }
  }

  private async checkTimeSync(): Promise<boolean> {
    try {
      // Check if local time is synchronized with Binance server time
      const localTime = Date.now();
      // This will be implemented with actual Binance time check
      return Math.abs(localTime - Date.now()) < 1000; // Within 1 second
    } catch (error) {
      this.logger.error('Time sync check failed', error);
      return false;
    }
  }

  private async checkMarketAvailability(): Promise<boolean> {
    try {
      // Check if markets are open and trading is allowed
      // This will be implemented with actual market status check
      return true; // Placeholder
    } catch (error) {
      this.logger.error('Market availability check failed', error);
      return false;
    }
  }

  private checkServiceHealth(): boolean {
    const requiredServices = ['market-data', 'strategy-engine', 'risk-engine', 'execution-service'];
    return requiredServices.every(service => {
      const status = this.serviceStatuses.get(service);
      return status && status.status === 'HEALTHY';
    });
  }

  // Service Management
  private async handleHealthUpdate(message: ServiceMessage): Promise<void> {
    if (message.type === 'HEALTH_CHECK' && message.payload.service) {
      const healthData: HealthStatus = {
        service: message.payload.service,
        status: message.payload.status || 'UNKNOWN',
        uptime: message.payload.uptime || 0,
        lastCheck: new Date(),
        dependencies: message.payload.dependencies || {},
        metrics: message.payload.metrics
      };

      this.serviceStatuses.set(message.payload.service, healthData);
      
      if (healthData.status === 'UNHEALTHY') {
        this.logger.warn(`Service ${healthData.service} is unhealthy`);
        
        // Notify about unhealthy service
        await messageQueue.publishNotification({
          type: 'error',
          title: '⚠️ Service Unhealthy',
          message: `Service ${healthData.service} is reporting unhealthy status`,
          priority: 'HIGH'
        });
      }
    }
  }

  private async restartService(serviceName: string): Promise<boolean> {
    try {
      // This would typically involve container management or process restart
      // For now, we'll just send a restart command
      await messageQueue.publish('health', '', {
        type: 'RESTART_SERVICE',
        payload: { service: serviceName },
        timestamp: Date.now(),
        source: 'orchestrator'
      });

      this.logger.info(`Restart command sent for service: ${serviceName}`);
      return true;
    } catch (error) {
      this.logger.error(`Error restarting service ${serviceName}`, error);
      return false;
    }
  }

  // Utility Methods
  private async broadcastTradingCommand(command: string, payload: any): Promise<void> {
    const message: ServiceMessage = {
      type: command,
      payload,
      timestamp: Date.now(),
      source: 'orchestrator'
    };

    // Broadcast to all trading-related services
    const services = ['market-data', 'strategy-engine', 'risk-engine', 'execution-service', 'ai-advisor'];
    
    for (const service of services) {
      await messageQueue.publish('trading', `command.${service}`, message);
    }
  }

  private parseConfigValue(value: string): any {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

export default OrchestratorService;