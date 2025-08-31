import MarketDataService from './services/MarketDataService';
import StrategyEngineService from './services/StrategyEngineService';
import RiskEngineService from './services/RiskEngineService';
import ExecutionService from './services/ExecutionService';
import AIAdvisorService from './services/AIAdvisorService';
import TelegramNotifierService from './services/TelegramNotifierService';
import { Config } from './config';
import { createLogger } from './utils/logger';

const logger = createLogger('main');

async function startService(serviceName: string) {
  try {
    Config.validate();
    
    let service;
    
    switch (serviceName) {
      case 'market-data':
        service = new MarketDataService();
        break;
      case 'strategy-engine':
        service = new StrategyEngineService();
        break;
      case 'risk-engine':
        service = new RiskEngineService();
        break;
      case 'execution-service':
        service = new ExecutionService();
        break;
      case 'ai-advisor':
        service = new AIAdvisorService();
        break;
      case 'notifier':
        service = new TelegramNotifierService();
        break;
      default:
        throw new Error(`Unknown service: ${serviceName}`);
    }

    await service.start();
    logger.info(`${serviceName} service started successfully`);

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info(`Received shutdown signal, stopping ${serviceName}...`);
      await service.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    logger.error(`Failed to start ${serviceName} service`, error);
    process.exit(1);
  }
}

// Get service name from command line args or environment
const serviceName = process.argv[2] || process.env.SERVICE_NAME;

if (!serviceName) {
  logger.error('Service name not provided');
  process.exit(1);
}

startService(serviceName);