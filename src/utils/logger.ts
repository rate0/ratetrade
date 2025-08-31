import winston from 'winston';
import path from 'path';
import { Config } from '@/config';

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const serviceName = service || 'unknown';
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${serviceName}] ${message} ${metaStr}`;
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss.SSS'
  }),
  winston.format.printf(({ timestamp, level, message, service }) => {
    const serviceName = service || 'unknown';
    return `[${timestamp}] [${level}] [${serviceName}] ${message}`;
  })
);

// Create transports
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: Config.NODE_ENV === 'production' ? logFormat : consoleFormat,
    level: Config.LOG_LEVEL
  })
];

// Add file transport if enabled
if (Config.LOG_FILE_ENABLED) {
  const logDir = path.dirname(Config.LOG_FILE_PATH);
  
  transports.push(
    new winston.transports.File({
      filename: Config.LOG_FILE_PATH,
      format: logFormat,
      level: Config.LOG_LEVEL,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );
  
  // Error log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      format: logFormat,
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: Config.LOG_LEVEL,
  format: logFormat,
  transports,
  exitOnError: false
});

// Logger class with service context
export class Logger {
  private serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  private log(level: string, message: string, meta?: any): void {
    logger.log(level, message, { service: this.serviceName, ...meta });
  }

  public debug(message: string, meta?: any): void {
    this.log('debug', message, meta);
  }

  public info(message: string, meta?: any): void {
    this.log('info', message, meta);
  }

  public warn(message: string, meta?: any): void {
    this.log('warn', message, meta);
  }

  public error(message: string, error?: Error | any, meta?: any): void {
    const errorMeta = error instanceof Error ? {
      stack: error.stack,
      name: error.name,
      message: error.message
    } : error;
    
    this.log('error', message, { error: errorMeta, ...meta });
  }

  public trade(action: string, symbol: string, data: any): void {
    this.info(`Trade executed: ${action} ${symbol}`, {
      type: 'trade',
      action,
      symbol,
      ...data
    });
  }

  public position(action: string, symbol: string, data: any): void {
    this.info(`Position ${action}: ${symbol}`, {
      type: 'position',
      action,
      symbol,
      ...data
    });
  }

  public risk(level: string, message: string, data: any): void {
    this.warn(`Risk ${level}: ${message}`, {
      type: 'risk',
      level,
      ...data
    });
  }

  public ai(action: string, confidence: number, reasoning: string): void {
    this.info(`AI Decision: ${action}`, {
      type: 'ai',
      action,
      confidence,
      reasoning
    });
  }

  public performance(metrics: any): void {
    this.info('Performance metrics updated', {
      type: 'performance',
      ...metrics
    });
  }

  public health(serviceName: string, status: string, metrics?: any): void {
    this.info(`Health check: ${serviceName} - ${status}`, {
      type: 'health',
      service: serviceName,
      status,
      ...metrics
    });
  }
}

// Create service-specific loggers
export const createLogger = (serviceName: string): Logger => {
  return new Logger(serviceName);
};

// Export default logger
export default logger;