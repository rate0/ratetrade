import Redis from 'ioredis';
import { Config } from '@/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('redis');

class RedisManager {
  private client: Redis;
  private subscriber: Redis;
  private publisher: Redis;
  private isConnected: boolean = false;

  constructor() {
    const redisConfig = {
      host: Config.REDIS_HOST,
      port: Config.REDIS_PORT,
      password: Config.REDIS_PASSWORD || undefined,
      db: Config.REDIS_DB,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true
    };

    this.client = new Redis(redisConfig);
    this.subscriber = new Redis(redisConfig);
    this.publisher = new Redis(redisConfig);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis client connected');
      this.isConnected = true;
    });

    this.client.on('error', (error) => {
      logger.error('Redis client error', error);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
    });

    this.subscriber.on('error', (error) => {
      logger.error('Redis subscriber error', error);
    });

    this.publisher.on('error', (error) => {
      logger.error('Redis publisher error', error);
    });
  }

  public async connect(): Promise<void> {
    try {
      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect()
      ]);
      logger.info('Redis connections established');
    } catch (error) {
      logger.error('Failed to connect to Redis', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await Promise.all([
        this.client.disconnect(),
        this.subscriber.disconnect(),
        this.publisher.disconnect()
      ]);
      logger.info('Redis connections closed');
    } catch (error) {
      logger.error('Error disconnecting from Redis', error);
      throw error;
    }
  }

  // Basic key-value operations
  public async set(key: string, value: any, ttl?: number): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttl) {
      await this.client.setex(key, ttl, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  public async get<T = any>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch {
      return value as unknown as T;
    }
  }

  public async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  public async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  public async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.client.expire(key, seconds);
    return result === 1;
  }

  // Hash operations
  public async hset(key: string, field: string, value: any): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await this.client.hset(key, field, serialized);
  }

  public async hget<T = any>(key: string, field: string): Promise<T | null> {
    const value = await this.client.hget(key, field);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch {
      return value as unknown as T;
    }
  }

  public async hgetall<T = any>(key: string): Promise<Record<string, T>> {
    const hash = await this.client.hgetall(key);
    const result: Record<string, T> = {};
    
    for (const [field, value] of Object.entries(hash)) {
      try {
        result[field] = JSON.parse(value);
      } catch {
        result[field] = value as unknown as T;
      }
    }
    
    return result;
  }

  public async hdel(key: string, field: string): Promise<number> {
    return this.client.hdel(key, field);
  }

  // List operations
  public async lpush(key: string, ...values: any[]): Promise<number> {
    const serialized = values.map(v => typeof v === 'string' ? v : JSON.stringify(v));
    return this.client.lpush(key, ...serialized);
  }

  public async rpush(key: string, ...values: any[]): Promise<number> {
    const serialized = values.map(v => typeof v === 'string' ? v : JSON.stringify(v));
    return this.client.rpush(key, ...serialized);
  }

  public async lpop<T = any>(key: string): Promise<T | null> {
    const value = await this.client.lpop(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch {
      return value as unknown as T;
    }
  }

  public async rpop<T = any>(key: string): Promise<T | null> {
    const value = await this.client.rpop(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch {
      return value as unknown as T;
    }
  }

  public async lrange<T = any>(key: string, start: number, stop: number): Promise<T[]> {
    const values = await this.client.lrange(key, start, stop);
    return values.map(value => {
      try {
        return JSON.parse(value);
      } catch {
        return value as unknown as T;
      }
    });
  }

  // Set operations
  public async sadd(key: string, ...members: any[]): Promise<number> {
    const serialized = members.map(m => typeof m === 'string' ? m : JSON.stringify(m));
    return this.client.sadd(key, ...serialized);
  }

  public async smembers<T = any>(key: string): Promise<T[]> {
    const members = await this.client.smembers(key);
    return members.map(member => {
      try {
        return JSON.parse(member);
      } catch {
        return member as unknown as T;
      }
    });
  }

  public async srem(key: string, ...members: any[]): Promise<number> {
    const serialized = members.map(m => typeof m === 'string' ? m : JSON.stringify(m));
    return this.client.srem(key, ...serialized);
  }

  // Pub/Sub operations
  public async publish(channel: string, message: any): Promise<number> {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);
    return this.publisher.publish(channel, serialized);
  }

  public async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) {
        try {
          const parsed = JSON.parse(message);
          callback(parsed);
        } catch {
          callback(message);
        }
      }
    });
  }

  public async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  // Lock operations
  public async acquireLock(key: string, ttl: number = 10000): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const identifier = `${Date.now()}-${Math.random()}`;
    
    const result = await this.client.set(lockKey, identifier, 'PX', ttl, 'NX');
    return result === 'OK';
  }

  public async releaseLock(key: string): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const result = await this.client.del(lockKey);
    return result === 1;
  }

  // Health check
  public async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed', error);
      return false;
    }
  }

  public isHealthy(): boolean {
    return this.isConnected;
  }

  public getClient(): Redis {
    return this.client;
  }

  // Cache utilities specific to trading
  public async cacheMarketData(symbol: string, data: any, ttl: number = 30): Promise<void> {
    await this.set(`market:${symbol}`, data, ttl);
  }

  public async getMarketData<T>(symbol: string): Promise<T | null> {
    return this.get<T>(`market:${symbol}`);
  }

  public async cachePosition(symbol: string, position: any): Promise<void> {
    await this.hset('positions', symbol, position);
  }

  public async getPosition<T>(symbol: string): Promise<T | null> {
    return this.hget<T>('positions', symbol);
  }

  public async getAllPositions<T>(): Promise<Record<string, T>> {
    return this.hgetall<T>('positions');
  }

  public async removePosition(symbol: string): Promise<void> {
    await this.hdel('positions', symbol);
  }

  public async cacheRiskMetrics(metrics: any, ttl: number = 60): Promise<void> {
    await this.set('risk:current', metrics, ttl);
  }

  public async getRiskMetrics<T>(): Promise<T | null> {
    return this.get<T>('risk:current');
  }

  public async cacheTradingConfig(config: any): Promise<void> {
    await this.set('config:trading', config);
  }

  public async getTradingConfig<T>(): Promise<T | null> {
    return this.get<T>('config:trading');
  }
}

// Export singleton instance
export const redis = new RedisManager();
export default redis;