import { config } from 'dotenv';
import { TradingConfig, NotificationConfig, ServiceConfig } from '@/types';

// Load environment variables
config();

export class Config {
  // Environment
  public static readonly NODE_ENV = process.env.NODE_ENV || 'development';
  public static readonly TZ = process.env.TZ || 'Asia/Almaty';
  public static readonly BOT_MODE = (process.env.BOT_MODE as 'LIVE' | 'SIM') || 'SIM';
  public static readonly BOT_NAME = process.env.BOT_NAME || 'CryptoTradingBot';

  // Binance Configuration
  public static readonly BINANCE_KEY = process.env.BINANCE_KEY || '';
  public static readonly BINANCE_SECRET = process.env.BINANCE_SECRET || '';
  public static readonly BINANCE_TESTNET = process.env.BINANCE_TESTNET === 'true';
  public static readonly BINANCE_SANDBOX = process.env.BINANCE_SANDBOX === 'true';

  // Telegram Configuration
  public static readonly TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
  public static readonly TELEGRAM_WHITELIST_IDS = process.env.TELEGRAM_WHITELIST_IDS
    ?.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id)) || [];

  // OpenAI Configuration
  public static readonly OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  public static readonly OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo-preview';
  public static readonly OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '1500');

  // Database Configuration
  public static readonly POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost';
  public static readonly POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || '5432');
  public static readonly POSTGRES_DB = process.env.POSTGRES_DB || 'trading_bot';
  public static readonly POSTGRES_USER = process.env.POSTGRES_USER || 'trading_user';
  public static readonly POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || '';

  // Redis Configuration
  public static readonly REDIS_HOST = process.env.REDIS_HOST || 'localhost';
  public static readonly REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
  public static readonly REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
  public static readonly REDIS_DB = parseInt(process.env.REDIS_DB || '0');

  // RabbitMQ Configuration
  public static readonly RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'localhost';
  public static readonly RABBITMQ_PORT = parseInt(process.env.RABBITMQ_PORT || '5672');
  public static readonly RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest';
  public static readonly RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'guest';
  public static readonly RABBITMQ_VHOST = process.env.RABBITMQ_VHOST || '/';

  // Service Ports
  public static readonly ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT || '3000');
  public static readonly MARKET_DATA_PORT = parseInt(process.env.MARKET_DATA_PORT || '3001');
  public static readonly STRATEGY_ENGINE_PORT = parseInt(process.env.STRATEGY_ENGINE_PORT || '3002');
  public static readonly RISK_ENGINE_PORT = parseInt(process.env.RISK_ENGINE_PORT || '3003');
  public static readonly EXECUTION_SERVICE_PORT = parseInt(process.env.EXECUTION_SERVICE_PORT || '3004');
  public static readonly AI_ADVISOR_PORT = parseInt(process.env.AI_ADVISOR_PORT || '3005');
  public static readonly NOTIFIER_SERVICE_PORT = parseInt(process.env.NOTIFIER_SERVICE_PORT || '3006');
  public static readonly STORAGE_SERVICE_PORT = parseInt(process.env.STORAGE_SERVICE_PORT || '3007');
  public static readonly WATCHDOG_SERVICE_PORT = parseInt(process.env.WATCHDOG_SERVICE_PORT || '3008');

  // JWT Configuration
  public static readonly JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-in-production';
  public static readonly JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

  // Trading Configuration
  public static readonly MAX_DAILY_LOSS_PERCENT = parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '5');
  public static readonly DEFAULT_LEVERAGE = parseInt(process.env.DEFAULT_LEVERAGE || '5');
  public static readonly MAX_LEVERAGE = parseInt(process.env.MAX_LEVERAGE || '10');
  public static readonly MAX_POSITION_PERCENT = parseFloat(process.env.MAX_POSITION_PERCENT || '30');
  public static readonly RISK_FREE_RATE = parseFloat(process.env.RISK_FREE_RATE || '0.05');

  // AI Configuration
  public static readonly AI_VOLATILITY_THRESHOLD = parseFloat(process.env.AI_VOLATILITY_THRESHOLD || '40');
  public static readonly AI_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || '80');
  public static readonly AI_USAGE_COST_LIMIT = parseFloat(process.env.AI_USAGE_COST_LIMIT || '50');

  // Logging Configuration
  public static readonly LOG_LEVEL = process.env.LOG_LEVEL || 'info';
  public static readonly LOG_FILE_ENABLED = process.env.LOG_FILE_ENABLED === 'true';
  public static readonly LOG_FILE_PATH = process.env.LOG_FILE_PATH || './logs/trading-bot.log';

  // Monitoring Configuration
  public static readonly METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
  public static readonly HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000');
  public static readonly SERVICE_TIMEOUT = parseInt(process.env.SERVICE_TIMEOUT || '10000');

  // Trading symbols
  public static readonly TRADING_SYMBOLS = [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'ADAUSDT',
    'DOTUSDT',
    'LINKUSDT',
    'LTCUSDT',
    'BCHUSDT',
    'XLMUSDT',
    'EOSUSDT'
  ];

  // Service configurations
  public static getServiceConfig(serviceName: string): ServiceConfig {
    const configs: Record<string, ServiceConfig> = {
      orchestrator: {
        name: 'orchestrator',
        port: Config.ORCHESTRATOR_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['postgres', 'redis', 'rabbitmq']
      },
      'market-data': {
        name: 'market-data',
        port: Config.MARKET_DATA_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['redis', 'rabbitmq']
      },
      'strategy-engine': {
        name: 'strategy-engine',
        port: Config.STRATEGY_ENGINE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['redis', 'rabbitmq']
      },
      'risk-engine': {
        name: 'risk-engine',
        port: Config.RISK_ENGINE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['postgres', 'redis', 'rabbitmq']
      },
      'execution-service': {
        name: 'execution-service',
        port: Config.EXECUTION_SERVICE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['postgres', 'redis', 'rabbitmq']
      },
      'ai-advisor': {
        name: 'ai-advisor',
        port: Config.AI_ADVISOR_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['redis', 'rabbitmq']
      },
      'notifier-service': {
        name: 'notifier-service',
        port: Config.NOTIFIER_SERVICE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['redis', 'rabbitmq']
      },
      'storage-service': {
        name: 'storage-service',
        port: Config.STORAGE_SERVICE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: ['postgres', 'redis']
      },
      'watchdog-service': {
        name: 'watchdog-service',
        port: Config.WATCHDOG_SERVICE_PORT,
        host: 'localhost',
        healthPath: '/health',
        dependencies: []
      }
    };

    return configs[serviceName] || {
      name: serviceName,
      port: 3000,
      host: 'localhost',
      healthPath: '/health',
      dependencies: []
    };
  }

  public static getTradingConfig(): TradingConfig {
    return {
      mode: Config.BOT_MODE,
      maxDailyLossPercent: Config.MAX_DAILY_LOSS_PERCENT,
      defaultLeverage: Config.DEFAULT_LEVERAGE,
      maxLeverage: Config.MAX_LEVERAGE,
      maxPositionPercent: Config.MAX_POSITION_PERCENT,
      riskFreeRate: Config.RISK_FREE_RATE,
      symbols: Config.TRADING_SYMBOLS,
      strategies: ['momentum', 'mean-reversion', 'funding-arbitrage']
    };
  }

  public static getNotificationConfig(): NotificationConfig {
    return {
      telegram: {
        token: Config.TELEGRAM_TOKEN,
        whitelistIds: Config.TELEGRAM_WHITELIST_IDS
      },
      alerts: {
        trades: true,
        positions: true,
        risk: true,
        ai: true,
        errors: true
      }
    };
  }

  public static validate(): void {
    const required = [
      'BINANCE_KEY',
      'BINANCE_SECRET',
      'TELEGRAM_TOKEN',
      'POSTGRES_PASSWORD',
      'JWT_SECRET'
    ];

    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (Config.TELEGRAM_WHITELIST_IDS.length === 0) {
      throw new Error('TELEGRAM_WHITELIST_IDS must contain at least one user ID');
    }

    if (Config.BOT_MODE !== 'LIVE' && Config.BOT_MODE !== 'SIM') {
      throw new Error('BOT_MODE must be either LIVE or SIM');
    }
  }

  // Database connection string
  public static getDatabaseUrl(): string {
    return `postgresql://${Config.POSTGRES_USER}:${Config.POSTGRES_PASSWORD}@${Config.POSTGRES_HOST}:${Config.POSTGRES_PORT}/${Config.POSTGRES_DB}`;
  }

  // Redis connection string
  public static getRedisUrl(): string {
    const auth = Config.REDIS_PASSWORD ? `:${Config.REDIS_PASSWORD}@` : '';
    return `redis://${auth}${Config.REDIS_HOST}:${Config.REDIS_PORT}/${Config.REDIS_DB}`;
  }

  // RabbitMQ connection string
  public static getRabbitMQUrl(): string {
    return `amqp://${Config.RABBITMQ_USER}:${Config.RABBITMQ_PASSWORD}@${Config.RABBITMQ_HOST}:${Config.RABBITMQ_PORT}${Config.RABBITMQ_VHOST}`;
  }
}