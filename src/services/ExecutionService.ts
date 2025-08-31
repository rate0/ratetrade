import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { Order, Position, Signal, ServiceMessage, TradingError } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import { binanceAPI } from '@/utils/binance';
import Joi from 'joi';

interface ExecutionConfig {
  slippageTolerance: number;
  maxOrderRetries: number;
  orderTimeout: number;
  partialFillThreshold: number;
  simulationMode: boolean;
}

interface OrderExecution {
  orderId: string;
  status: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  lastAttempt: Date;
  error?: string;
}

interface SimulatedExecution {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  executedPrice: number;
  slippage: number;
  fee: number;
  timestamp: Date;
}

export class ExecutionService extends BaseService {
  private config: ExecutionConfig;
  private pendingOrders: Map<string, OrderExecution> = new Map();
  private orderHistory: Map<string, Order> = new Map();
  private isExecuting: boolean = false;
  private executionInterval: NodeJS.Timeout | null = null;
  private simulatedBalance: number = 100000; // $100k for simulation

  constructor() {
    super('execution-service');
    this.config = {
      slippageTolerance: 0.1, // 0.1%
      maxOrderRetries: 3,
      orderTimeout: 30000, // 30 seconds
      partialFillThreshold: 0.1, // 10%
      simulationMode: Config.BOT_MODE === 'SIM'
    };
    this.setupRoutes();
  }

  protected async initialize(): Promise<void> {
    await messageQueue.subscribe('order.execution', this.handleCommand.bind(this));
    await this.loadOrderHistory();
    await this.startOrderExecution();
    
    this.logger.info('Execution Service initialized', { 
      mode: this.config.simulationMode ? 'SIM' : 'LIVE' 
    });
  }

  protected async cleanup(): Promise<void> {
    await this.stopOrderExecution();
    this.logger.info('Execution Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();

    // Order management routes
    app.post('/api/orders', this.asyncHandler(this.createOrderHandler.bind(this)));
    app.get('/api/orders/:id', this.asyncHandler(this.getOrderHandler.bind(this)));
    app.delete('/api/orders/:id', this.asyncHandler(this.cancelOrderHandler.bind(this)));
    app.get('/api/orders', this.asyncHandler(this.getOrdersHandler.bind(this)));

    // Position management routes
    app.get('/api/positions', this.asyncHandler(this.getPositionsHandler.bind(this)));
    app.post('/api/positions/close/:symbol', this.asyncHandler(this.closePositionHandler.bind(this)));
    app.post('/api/positions/close-all', this.asyncHandler(this.closeAllPositionsHandler.bind(this)));

    // Execution management
    app.get('/api/execution/status', this.asyncHandler(this.getExecutionStatusHandler.bind(this)));
    app.get('/api/execution/config', this.asyncHandler(this.getExecutionConfigHandler.bind(this)));
    app.put('/api/execution/config', this.asyncHandler(this.updateExecutionConfigHandler.bind(this)));

    // Simulation routes (SIM mode only)
    if (this.config.simulationMode) {
      app.get('/api/simulation/balance', this.asyncHandler(this.getSimulatedBalanceHandler.bind(this)));
      app.post('/api/simulation/reset', this.asyncHandler(this.resetSimulationHandler.bind(this)));
    }
  }

  // Route Handlers
  private async createOrderHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      symbol: Joi.string().required(),
      side: Joi.string().valid('BUY', 'SELL').required(),
      type: Joi.string().valid('MARKET', 'LIMIT', 'STOP', 'STOP_MARKET').default('MARKET'),
      quantity: Joi.number().positive().required(),
      price: Joi.number().positive(),
      stopPrice: Joi.number().positive(),
      timeInForce: Joi.string().valid('GTC', 'IOC', 'FOK').default('GTC'),
      leverage: Joi.number().min(1).max(125)
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const order = await this.createOrder(req.body);
      this.sendResponse(res, true, order);
    } catch (error) {
      this.logger.error('Error creating order', error);
      this.sendResponse(res, false, null, 'Failed to create order');
    }
  }

  private async getOrderHandler(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const order = await this.getOrder(id);
      
      if (!order) {
        this.sendResponse(res, false, null, 'Order not found');
        return;
      }

      this.sendResponse(res, true, order);
    } catch (error) {
      this.logger.error('Error fetching order', error);
      this.sendResponse(res, false, null, 'Failed to fetch order');
    }
  }

  private async cancelOrderHandler(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const success = await this.cancelOrder(id);
      this.sendResponse(res, success, { cancelled: success });
    } catch (error) {
      this.logger.error('Error cancelling order', error);
      this.sendResponse(res, false, null, 'Failed to cancel order');
    }
  }

  private async getOrdersHandler(req: Request, res: Response): Promise<void> {
    try {
      const { status, symbol, limit = 50 } = req.query;
      const orders = await this.getOrders({ status, symbol, limit: parseInt(limit as string) });
      this.sendResponse(res, true, orders);
    } catch (error) {
      this.logger.error('Error fetching orders', error);
      this.sendResponse(res, false, null, 'Failed to fetch orders');
    }
  }

  private async getPositionsHandler(req: Request, res: Response): Promise<void> {
    try {
      const positions = await this.getPositions();
      this.sendResponse(res, true, positions);
    } catch (error) {
      this.logger.error('Error fetching positions', error);
      this.sendResponse(res, false, null, 'Failed to fetch positions');
    }
  }

  private async closePositionHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const success = await this.closePosition(symbol);
      this.sendResponse(res, success, { closed: success });
    } catch (error) {
      this.logger.error('Error closing position', error);
      this.sendResponse(res, false, null, 'Failed to close position');
    }
  }

  private async closeAllPositionsHandler(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.closeAllPositions();
      this.sendResponse(res, success, { closedAll: success });
    } catch (error) {
      this.logger.error('Error closing all positions', error);
      this.sendResponse(res, false, null, 'Failed to close all positions');
    }
  }

  private async getExecutionStatusHandler(req: Request, res: Response): Promise<void> {
    const status = {
      isExecuting: this.isExecuting,
      pendingOrders: this.pendingOrders.size,
      mode: this.config.simulationMode ? 'SIM' : 'LIVE',
      config: this.config
    };
    this.sendResponse(res, true, status);
  }

  private async getExecutionConfigHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.config);
  }

  private async updateExecutionConfigHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      slippageTolerance: Joi.number().min(0).max(5),
      maxOrderRetries: Joi.number().min(1).max(10),
      orderTimeout: Joi.number().min(5000).max(120000),
      partialFillThreshold: Joi.number().min(0).max(1)
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      this.config = { ...this.config, ...req.body };
      this.sendResponse(res, true, this.config);
    } catch (error) {
      this.logger.error('Error updating config', error);
      this.sendResponse(res, false, null, 'Failed to update config');
    }
  }

  private async getSimulatedBalanceHandler(req: Request, res: Response): Promise<void> {
    if (!this.config.simulationMode) {
      this.sendResponse(res, false, null, 'Not in simulation mode');
      return;
    }
    this.sendResponse(res, true, { balance: this.simulatedBalance });
  }

  private async resetSimulationHandler(req: Request, res: Response): Promise<void> {
    if (!this.config.simulationMode) {
      this.sendResponse(res, false, null, 'Not in simulation mode');
      return;
    }
    
    this.simulatedBalance = 100000;
    this.orderHistory.clear();
    this.sendResponse(res, true, { balance: this.simulatedBalance });
  }

  // Command Handler
  private async handleCommand(message: ServiceMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'START_TRADING':
          await this.startOrderExecution();
          break;
        case 'STOP_TRADING':
          await this.stopOrderExecution();
          break;
        case 'TRADING_SIGNAL':
          await this.handleTradingSignal(message.payload);
          break;
        case 'CLOSE_ALL_POSITIONS':
          await this.closeAllPositions();
          break;
        case 'EMERGENCY_STOP':
          await this.emergencyStop();
          break;
        default:
          this.logger.warn('Unknown command received', { type: message.type });
      }
    } catch (error) {
      this.logger.error('Error handling command', error, { command: message.type });
    }
  }

  // Order Management
  private async createOrder(orderParams: any): Promise<Order> {
    try {
      let order: Order;

      if (this.config.simulationMode) {
        order = await this.simulateOrderExecution(orderParams);
      } else {
        order = await binanceAPI.createOrder(orderParams);
      }

      // Store order
      this.orderHistory.set(order.id, order);
      await this.storeOrder(order);

      // Add to pending orders for monitoring
      this.pendingOrders.set(order.id, {
        orderId: order.id,
        status: 'PENDING',
        attempts: 0,
        lastAttempt: new Date()
      });

      this.logger.info('Order created', {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        mode: this.config.simulationMode ? 'SIM' : 'LIVE'
      });

      // Publish order update
      await messageQueue.publishOrderUpdate(order);

      return order;
    } catch (error) {
      this.logger.error('Error creating order', error);
      throw new TradingError('Failed to create order', 'ORDER_CREATE_ERROR');
    }
  }

  private async simulateOrderExecution(orderParams: any): Promise<Order> {
    const { symbol, side, type, quantity, price } = orderParams;
    
    // Get current market price
    const marketData = await redis.getMarketData(symbol);
    const currentPrice = marketData?.price || price || 0;
    
    // Calculate slippage
    const slippage = this.calculateSlippage(quantity, currentPrice);
    const executedPrice = type === 'MARKET' ? 
      this.applySlippage(currentPrice, side, slippage) : 
      price;

    // Calculate fees (0.04% for futures)
    const fee = quantity * executedPrice * 0.0004;
    
    // Update simulated balance
    const cost = quantity * executedPrice + fee;
    if (side === 'BUY') {
      this.simulatedBalance -= cost;
    } else {
      this.simulatedBalance += cost - fee;
    }

    const order: Order = {
      id: `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      symbol,
      side: side as 'BUY' | 'SELL',
      type: type as any,
      quantity,
      price: executedPrice,
      status: 'FILLED',
      executedQty: quantity,
      averagePrice: executedPrice,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Store simulated execution
    const execution: SimulatedExecution = {
      orderId: order.id,
      symbol,
      side,
      quantity,
      price: currentPrice,
      executedPrice,
      slippage,
      fee,
      timestamp: new Date()
    };

    await redis.set(`sim_execution:${order.id}`, execution);

    this.logger.info('Order simulated', {
      orderId: order.id,
      executedPrice,
      slippage,
      fee,
      newBalance: this.simulatedBalance
    });

    return order;
  }

  private calculateSlippage(quantity: number, price: number): number {
    // Simple slippage model based on order size
    const orderValue = quantity * price;
    const baseSlippage = 0.05; // 0.05% base slippage
    const volumeImpact = Math.log(orderValue / 10000) * 0.01; // Additional impact for large orders
    
    return Math.max(0, baseSlippage + volumeImpact);
  }

  private applySlippage(price: number, side: string, slippagePercent: number): number {
    const slippageFactor = slippagePercent / 100;
    return side === 'BUY' ? 
      price * (1 + slippageFactor) : 
      price * (1 - slippageFactor);
  }

  private async getOrder(orderId: string): Promise<Order | null> {
    // Check local cache first
    const cached = this.orderHistory.get(orderId);
    if (cached) return cached;

    // Check database
    const result = await db.query(
      'SELECT * FROM orders WHERE id = $1',
      [orderId]
    );

    if (result.length > 0) {
      return this.mapDbOrderToOrder(result[0]);
    }

    // Check Binance if in LIVE mode
    if (!this.config.simulationMode) {
      try {
        const symbol = cached?.symbol || '';
        return await binanceAPI.getOrder(orderId, symbol);
      } catch (error) {
        this.logger.warn('Order not found on Binance', { orderId });
      }
    }

    return null;
  }

  private async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const order = await this.getOrder(orderId);
      if (!order) {
        this.logger.warn('Order not found for cancellation', { orderId });
        return false;
      }

      if (this.config.simulationMode) {
        // Update order status in simulation
        order.status = 'CANCELED';
        this.orderHistory.set(orderId, order);
        await this.updateOrderInDb(order);
      } else {
        await binanceAPI.cancelOrder(orderId, order.symbol);
      }

      // Remove from pending orders
      this.pendingOrders.delete(orderId);

      this.logger.info('Order cancelled', { orderId });
      await messageQueue.publishOrderUpdate(order);

      return true;
    } catch (error) {
      this.logger.error('Error cancelling order', error, { orderId });
      return false;
    }
  }

  private async getOrders(filters: any = {}): Promise<Order[]> {
    let query = 'SELECT * FROM orders WHERE 1=1';
    const params: any[] = [];

    if (filters.status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(filters.status);
    }

    if (filters.symbol) {
      query += ` AND symbol = $${params.length + 1}`;
      params.push(filters.symbol);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(filters.limit || 50);

    const result = await db.query(query, params);
    return result.map(row => this.mapDbOrderToOrder(row));
  }

  // Position Management
  private async getPositions(): Promise<Position[]> {
    if (this.config.simulationMode) {
      return this.getSimulatedPositions();
    } else {
      return await binanceAPI.getFuturesPositions();
    }
  }

  private async getSimulatedPositions(): Promise<Position[]> {
    // For simulation, calculate positions from order history
    const positions: Map<string, Position> = new Map();
    
    for (const order of this.orderHistory.values()) {
      if (order.status === 'FILLED') {
        const existing = positions.get(order.symbol);
        
        if (existing) {
          // Update existing position
          if (order.side === 'BUY') {
            existing.size += order.executedQty;
          } else {
            existing.size -= order.executedQty;
          }
          
          // Recalculate average entry price
          if (existing.size > 0) {
            existing.entryPrice = ((existing.entryPrice * (existing.size - order.executedQty)) + 
                                 (order.averagePrice! * order.executedQty)) / existing.size;
          }
        } else {
          // Create new position
          positions.set(order.symbol, {
            symbol: order.symbol,
            side: order.side === 'BUY' ? 'LONG' : 'SHORT',
            size: order.executedQty,
            entryPrice: order.averagePrice!,
            markPrice: order.averagePrice!,
            unrealizedPnl: 0,
            leverage: 1,
            marginUsed: order.executedQty * order.averagePrice!
          });
        }
      }
    }

    return Array.from(positions.values()).filter(pos => pos.size > 0);
  }

  private async closePosition(symbol: string): Promise<boolean> {
    try {
      if (this.config.simulationMode) {
        return await this.closeSimulatedPosition(symbol);
      } else {
        return await binanceAPI.closePosition(symbol);
      }
    } catch (error) {
      this.logger.error('Error closing position', error, { symbol });
      return false;
    }
  }

  private async closeSimulatedPosition(symbol: string): Promise<boolean> {
    const positions = await this.getSimulatedPositions();
    const position = positions.find(pos => pos.symbol === symbol);
    
    if (!position) {
      this.logger.warn('No position found to close', { symbol });
      return true;
    }

    // Create closing order
    const side = position.side === 'LONG' ? 'SELL' : 'BUY';
    await this.createOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: position.size
    });

    this.logger.info('Simulated position closed', { symbol, size: position.size });
    return true;
  }

  private async closeAllPositions(): Promise<boolean> {
    try {
      const positions = await this.getPositions();
      const closePromises = positions.map(position => 
        this.closePosition(position.symbol)
      );

      const results = await Promise.all(closePromises);
      const success = results.every(result => result);

      this.logger.info('Close all positions completed', { 
        success, 
        positions: positions.length 
      });

      return success;
    } catch (error) {
      this.logger.error('Error closing all positions', error);
      return false;
    }
  }

  // Signal Handling
  private async handleTradingSignal(signal: Signal): Promise<void> {
    try {
      this.logger.info('Processing trading signal', {
        symbol: signal.symbol,
        action: signal.action,
        confidence: signal.confidence
      });

      if (signal.action === 'CLOSE') {
        await this.closePosition(signal.symbol);
        return;
      }

      // Get current market price
      const marketData = await redis.getMarketData(signal.symbol);
      if (!marketData) {
        this.logger.warn('No market data available for signal', { symbol: signal.symbol });
        return;
      }

      // Request position size calculation from risk engine
      const positionSize = await messageQueue.request(
        'trading',
        'risk.calculate_size',
        {
          signal,
          currentPrice: marketData.price
        },
        10000
      );

      if (!positionSize || positionSize.size <= 0) {
        this.logger.warn('Invalid position size calculated', { signal: signal.symbol });
        return;
      }

      // Create order
      const orderParams = {
        symbol: signal.symbol,
        side: signal.action === 'BUY' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: positionSize.size,
        leverage: positionSize.leverage
      };

      await this.createOrder(orderParams);

    } catch (error) {
      this.logger.error('Error processing trading signal', error, { signal: signal.symbol });
    }
  }

  // Execution Management
  private async startOrderExecution(): Promise<void> {
    if (this.isExecuting) return;

    this.isExecuting = true;
    
    // Start order monitoring
    this.executionInterval = setInterval(async () => {
      await this.monitorOrders();
    }, 5000); // Check every 5 seconds

    this.logger.info('Order execution started');
  }

  private async stopOrderExecution(): Promise<void> {
    if (!this.isExecuting) return;

    this.isExecuting = false;

    if (this.executionInterval) {
      clearInterval(this.executionInterval);
      this.executionInterval = null;
    }

    this.logger.info('Order execution stopped');
  }

  private async monitorOrders(): Promise<void> {
    for (const [orderId, execution] of this.pendingOrders) {
      try {
        await this.checkOrderStatus(orderId, execution);
      } catch (error) {
        this.logger.error('Error monitoring order', error, { orderId });
      }
    }
  }

  private async checkOrderStatus(orderId: string, execution: OrderExecution): Promise<void> {
    if (this.config.simulationMode) {
      // In simulation mode, orders are executed immediately
      this.pendingOrders.delete(orderId);
      return;
    }

    try {
      const order = await this.getOrder(orderId);
      if (!order) {
        this.logger.warn('Order not found during monitoring', { orderId });
        this.pendingOrders.delete(orderId);
        return;
      }

      if (order.status === 'FILLED' || order.status === 'CANCELED' || order.status === 'REJECTED') {
        this.pendingOrders.delete(orderId);
        await this.updateOrderInDb(order);
        await messageQueue.publishOrderUpdate(order);
        
        this.logger.info('Order completed', {
          orderId,
          status: order.status,
          executedQty: order.executedQty
        });
      } else if (Date.now() - execution.lastAttempt.getTime() > this.config.orderTimeout) {
        // Order timeout
        if (execution.attempts < this.config.maxOrderRetries) {
          execution.attempts++;
          execution.lastAttempt = new Date();
          this.logger.warn('Order timeout, retrying', { orderId, attempt: execution.attempts });
        } else {
          await this.cancelOrder(orderId);
          this.logger.error('Order failed after max retries', { orderId });
        }
      }
    } catch (error) {
      this.logger.error('Error checking order status', error, { orderId });
    }
  }

  // Database Operations
  private async storeOrder(order: Order): Promise<void> {
    await db.query(
      `INSERT INTO orders (
        id, symbol, side, type, quantity, price, status, executed_qty, 
        average_price, binance_order_id, mode, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        order.id,
        order.symbol,
        order.side,
        order.type,
        order.quantity,
        order.price,
        order.status,
        order.executedQty,
        order.averagePrice,
        order.binanceOrderId,
        Config.BOT_MODE,
        order.createdAt,
        order.updatedAt
      ]
    );
  }

  private async updateOrderInDb(order: Order): Promise<void> {
    await db.query(
      `UPDATE orders SET 
        status = $1, executed_qty = $2, average_price = $3, updated_at = $4
       WHERE id = $5`,
      [order.status, order.executedQty, order.averagePrice, new Date(), order.id]
    );
  }

  private mapDbOrderToOrder(row: any): Order {
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      quantity: parseFloat(row.quantity),
      price: row.price ? parseFloat(row.price) : undefined,
      status: row.status,
      executedQty: parseFloat(row.executed_qty || '0'),
      averagePrice: row.average_price ? parseFloat(row.average_price) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      binanceOrderId: row.binance_order_id
    };
  }

  private async loadOrderHistory(): Promise<void> {
    try {
      const orders = await this.getOrders({ limit: 100 });
      for (const order of orders) {
        this.orderHistory.set(order.id, order);
      }
      this.logger.info('Order history loaded', { orders: orders.length });
    } catch (error) {
      this.logger.error('Error loading order history', error);
    }
  }

  private async emergencyStop(): Promise<void> {
    this.logger.warn('Emergency stop initiated');
    
    // Cancel all pending orders
    for (const orderId of this.pendingOrders.keys()) {
      await this.cancelOrder(orderId);
    }

    // Close all positions
    await this.closeAllPositions();

    // Stop execution
    await this.stopOrderExecution();

    this.logger.warn('Emergency stop completed');
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      isExecuting: this.isExecuting,
      pendingOrders: this.pendingOrders.size,
      totalOrders: this.orderHistory.size,
      mode: this.config.simulationMode ? 'SIM' : 'LIVE',
      simulatedBalance: this.config.simulationMode ? this.simulatedBalance : null
    };
  }
}

export default ExecutionService;