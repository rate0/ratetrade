import OrchestratorService from './services/OrchestratorService';
import { Config } from './config';
import { createLogger } from './utils/logger';

const logger = createLogger('main');

async function main() {
  try {
    // Validate configuration
    Config.validate();
    
    // Create and start orchestrator service
    const service = new OrchestratorService();
    await service.start();

    logger.info('Orchestrator service started successfully');

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await service.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await service.stop();
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start orchestrator service', error);
    process.exit(1);
  }
}

main();