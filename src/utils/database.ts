import { Pool, PoolClient } from 'pg';
import { Config } from '@/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('database');

class DatabaseManager {
  private pool: Pool;
  private isConnected: boolean = false;

  constructor() {
    this.pool = new Pool({
      connectionString: Config.getDatabaseUrl(),
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      query_timeout: 30000
    });

    this.pool.on('connect', () => {
      logger.info('New database connection established');
    });

    this.pool.on('error', (err) => {
      logger.error('Database pool error', err);
    });
  }

  public async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      this.isConnected = true;
      logger.info('Database connected successfully');
    } catch (error) {
      this.isConnected = false;
      logger.error('Failed to connect to database', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.pool.end();
      this.isConnected = false;
      logger.info('Database disconnected');
    } catch (error) {
      logger.error('Error disconnecting from database', error);
      throw error;
    }
  }

  public async query<T = any>(text: string, params?: any[]): Promise<T[]> {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }

    const client = await this.pool.connect();
    try {
      const start = Date.now();
      const result = await client.query(text, params);
      const duration = Date.now() - start;
      
      if (duration > 1000) {
        logger.warn('Slow query detected', { query: text, duration, params });
      }
      
      return result.rows;
    } catch (error) {
      logger.error('Database query error', error, { query: text, params });
      throw error;
    } finally {
      client.release();
    }
  }

  public async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction rolled back', error);
      throw error;
    } finally {
      client.release();
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('Database health check failed', error);
      return false;
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  public isHealthy(): boolean {
    return this.isConnected;
  }
}

// Repository base class
export abstract class BaseRepository {
  protected db: DatabaseManager;
  protected tableName: string;

  constructor(db: DatabaseManager, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  protected async findById<T>(id: number | string): Promise<T | null> {
    const rows = await this.db.query<T>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  protected async findAll<T>(limit?: number, offset?: number): Promise<T[]> {
    let query = `SELECT * FROM ${this.tableName} ORDER BY created_at DESC`;
    const params: any[] = [];
    
    if (limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }
    
    if (offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(offset);
    }
    
    return this.db.query<T>(query, params);
  }

  protected async create<T>(data: Partial<T>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    
    const query = `
      INSERT INTO ${this.tableName} (${keys.join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;
    
    const rows = await this.db.query<T>(query, values);
    return rows[0];
  }

  protected async update<T>(id: number | string, data: Partial<T>): Promise<T | null> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
    
    const query = `
      UPDATE ${this.tableName}
      SET ${setClause}, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    
    const rows = await this.db.query<T>(query, [id, ...values]);
    return rows[0] || null;
  }

  protected async delete(id: number | string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    return result.length > 0;
  }
}

// Export singleton instance
export const db = new DatabaseManager();
export default db;