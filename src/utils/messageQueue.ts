import amqp, { Connection, Channel, Message } from 'amqplib';
import { Config } from '@/config';
import { createLogger } from '@/utils/logger';
import { ServiceMessage } from '@/types';

const logger = createLogger('messagequeue');

interface QueueConfig {
  durable: boolean;
  exclusive: boolean;
  autoDelete: boolean;
}

interface ExchangeConfig {
  type: string;
  durable: boolean;
  autoDelete: boolean;
}

class MessageQueue {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private isConnected: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private messageHandlers: Map<string, (msg: ServiceMessage) => Promise<void>> = new Map();

  // Queue configurations
  private readonly queues = {
    'market.data': { durable: true, exclusive: false, autoDelete: false },
    'trading.signals': { durable: true, exclusive: false, autoDelete: false },
    'risk.assessment': { durable: true, exclusive: false, autoDelete: false },
    'order.execution': { durable: true, exclusive: false, autoDelete: false },
    'ai.decisions': { durable: true, exclusive: false, autoDelete: false },
    'notifications': { durable: true, exclusive: false, autoDelete: false },
    'health.checks': { durable: false, exclusive: false, autoDelete: true }
  };

  // Exchange configurations
  private readonly exchanges = {
    'trading': { type: 'topic', durable: true, autoDelete: false },
    'notifications': { type: 'fanout', durable: true, autoDelete: false },
    'health': { type: 'fanout', durable: false, autoDelete: true }
  };

  constructor() {
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(Config.getRabbitMQUrl());
      this.channel = await this.connection.createChannel();

      // Set up error handlers
      this.connection.on('error', (error) => {
        logger.error('RabbitMQ connection error', error);
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.channel.on('error', (error) => {
        logger.error('RabbitMQ channel error', error);
      });

      this.channel.on('close', () => {
        logger.warn('RabbitMQ channel closed');
      });

      // Setup exchanges and queues
      await this.setupInfrastructure();

      this.isConnected = true;
      logger.info('RabbitMQ connected successfully');
    } catch (error) {
      logger.error('Failed to connect to RabbitMQ', error);
      this.scheduleReconnect();
      throw error;
    }
  }

  private async setupInfrastructure(): Promise<void> {
    if (!this.channel) throw new Error('Channel not available');

    // Create exchanges
    for (const [name, config] of Object.entries(this.exchanges)) {
      await this.channel.assertExchange(name, config.type, {
        durable: config.durable,
        autoDelete: config.autoDelete
      });
      logger.debug(`Exchange '${name}' created`);
    }

    // Create queues
    for (const [name, config] of Object.entries(this.queues)) {
      await this.channel.assertQueue(name, {
        durable: config.durable,
        exclusive: config.exclusive,
        autoDelete: config.autoDelete
      });
      logger.debug(`Queue '${name}' created`);
    }

    // Bind queues to exchanges
    await this.bindQueues();
  }

  private async bindQueues(): Promise<void> {
    if (!this.channel) return;

    // Bind trading queues to trading exchange
    await this.channel.bindQueue('market.data', 'trading', 'market.*');
    await this.channel.bindQueue('trading.signals', 'trading', 'signal.*');
    await this.channel.bindQueue('risk.assessment', 'trading', 'risk.*');
    await this.channel.bindQueue('order.execution', 'trading', 'order.*');
    await this.channel.bindQueue('ai.decisions', 'trading', 'ai.*');

    // Bind notification queue
    await this.channel.bindQueue('notifications', 'notifications', '');

    // Bind health check queue
    await this.channel.bindQueue('health.checks', 'health', '');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        logger.info('Attempting to reconnect to RabbitMQ...');
        await this.connect();
      } catch (error) {
        logger.error('Reconnection failed', error);
      }
    }, 5000);
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      this.isConnected = false;
      logger.info('RabbitMQ disconnected');
    } catch (error) {
      logger.error('Error disconnecting from RabbitMQ', error);
    }
  }

  public async publish(
    exchange: string,
    routingKey: string,
    message: ServiceMessage,
    options: any = {}
  ): Promise<boolean> {
    if (!this.channel || !this.isConnected) {
      logger.error('Cannot publish: RabbitMQ not connected');
      return false;
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const result = this.channel.publish(exchange, routingKey, buffer, {
        persistent: true,
        timestamp: Date.now(),
        ...options
      });

      if (result) {
        logger.debug(`Message published to ${exchange}/${routingKey}`, {
          type: message.type,
          source: message.source
        });
      }

      return result;
    } catch (error) {
      logger.error('Error publishing message', error);
      return false;
    }
  }

  public async subscribe(
    queue: string,
    handler: (msg: ServiceMessage) => Promise<void>,
    options: any = {}
  ): Promise<void> {
    if (!this.channel || !this.isConnected) {
      throw new Error('Cannot subscribe: RabbitMQ not connected');
    }

    this.messageHandlers.set(queue, handler);

    await this.channel.consume(queue, async (msg: Message | null) => {
      if (!msg) return;

      try {
        const message: ServiceMessage = JSON.parse(msg.content.toString());
        await handler(message);
        this.channel!.ack(msg);
        
        logger.debug(`Message processed from ${queue}`, {
          type: message.type,
          source: message.source
        });
      } catch (error) {
        logger.error(`Error processing message from ${queue}`, error);
        this.channel!.nack(msg, false, false); // Don't requeue failed messages
      }
    }, {
      noAck: false,
      ...options
    });

    logger.info(`Subscribed to queue: ${queue}`);
  }

  // Convenient methods for specific message types
  public async publishMarketData(symbol: string, data: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'MARKET_DATA_UPDATE',
      payload: { symbol, data },
      timestamp: Date.now(),
      source: 'market-data-service'
    };
    return this.publish('trading', `market.${symbol.toLowerCase()}`, message);
  }

  public async publishSignal(signal: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'TRADING_SIGNAL',
      payload: signal,
      timestamp: Date.now(),
      source: 'strategy-engine'
    };
    return this.publish('trading', `signal.${signal.symbol.toLowerCase()}`, message);
  }

  public async publishRiskUpdate(riskData: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'RISK_UPDATE',
      payload: riskData,
      timestamp: Date.now(),
      source: 'risk-engine'
    };
    return this.publish('trading', 'risk.update', message);
  }

  public async publishOrderUpdate(orderData: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'ORDER_UPDATE',
      payload: orderData,
      timestamp: Date.now(),
      source: 'execution-service'
    };
    return this.publish('trading', `order.${orderData.symbol.toLowerCase()}`, message);
  }

  public async publishAIDecision(decision: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'AI_DECISION',
      payload: decision,
      timestamp: Date.now(),
      source: 'ai-advisor'
    };
    return this.publish('trading', 'ai.decision', message);
  }

  public async publishNotification(notification: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'NOTIFICATION',
      payload: notification,
      timestamp: Date.now(),
      source: 'notifier-service'
    };
    return this.publish('notifications', '', message);
  }

  public async publishHealthCheck(serviceName: string, healthData: any): Promise<boolean> {
    const message: ServiceMessage = {
      type: 'HEALTH_CHECK',
      payload: { service: serviceName, ...healthData },
      timestamp: Date.now(),
      source: serviceName
    };
    return this.publish('health', '', message);
  }

  // RPC-style request/response
  public async request<T>(
    exchange: string,
    routingKey: string,
    requestData: any,
    timeout: number = 10000
  ): Promise<T> {
    if (!this.channel || !this.isConnected) {
      throw new Error('Cannot make request: RabbitMQ not connected');
    }

    const correlationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const replyQueue = await this.channel.assertQueue('', { exclusive: true, autoDelete: true });

    const message: ServiceMessage = {
      type: 'REQUEST',
      payload: requestData,
      timestamp: Date.now(),
      source: 'requester',
      correlationId
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, timeout);

      this.channel!.consume(replyQueue.queue, (msg) => {
        if (msg && msg.properties.correlationId === correlationId) {
          clearTimeout(timeoutId);
          const response = JSON.parse(msg.content.toString());
          this.channel!.ack(msg);
          resolve(response.payload);
        }
      }, { noAck: false });

      this.channel!.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
        correlationId,
        replyTo: replyQueue.queue,
        persistent: true
      });
    });
  }

  public async healthCheck(): Promise<boolean> {
    try {
      return this.isConnected && this.connection !== null && this.channel !== null;
    } catch (error) {
      logger.error('RabbitMQ health check failed', error);
      return false;
    }
  }

  public isHealthy(): boolean {
    return this.isConnected;
  }

  private async gracefulShutdown(): Promise<void> {
    logger.info('Gracefully shutting down RabbitMQ connection...');
    await this.disconnect();
  }
}

// Export singleton instance
export const messageQueue = new MessageQueue();
export default messageQueue;