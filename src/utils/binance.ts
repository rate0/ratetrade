import ccxt from 'ccxt';
import WebSocket from 'ws';
import { Config } from '@/config';
import { createLogger } from '@/utils/logger';
import { MarketData, OrderBook, Order, Position, TradingError } from '@/types';

const logger = createLogger('binance-api');

interface BinanceConfig {
  apiKey: string;
  secret: string;
  sandbox: boolean;
  testnet: boolean;
}

interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_market' | 'take_profit' | 'take_profit_market';
  amount: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  leverage?: number;
}

export class BinanceAPI {
  private exchange: ccxt.binance;
  private wsConnections: Map<string, WebSocket> = new Map();
  private marketDataCallbacks: Map<string, (data: MarketData) => void> = new Map();
  private orderBookCallbacks: Map<string, (data: OrderBook) => void> = new Map();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(config: BinanceConfig) {
    this.exchange = new ccxt.binance({
      apiKey: config.apiKey,
      secret: config.secret,
      sandbox: config.sandbox,
      enableRateLimit: true,
      rateLimit: 1200, // 50 requests per second
      options: {
        defaultType: 'future', // Use futures API
        adjustForTimeDifference: true
      }
    });

    if (config.testnet) {
      this.exchange.urls['api'] = this.exchange.urls['test'];
    }
  }

  public async initialize(): Promise<void> {
    try {
      // Test API connection
      await this.exchange.loadMarkets();
      
      // Test futures API specifically
      const balance = await this.getFuturesBalance();
      
      this.isConnected = true;
      logger.info('Binance API initialized successfully', {
        totalSymbols: Object.keys(this.exchange.markets).length,
        balance: balance.total
      });
    } catch (error) {
      this.isConnected = false;
      logger.error('Failed to initialize Binance API', error);
      throw new TradingError('Binance API initialization failed', 'API_INIT_ERROR', 'CRITICAL');
    }
  }

  // Account Information
  public async getFuturesBalance(): Promise<any> {
    try {
      const balance = await this.exchange.fetchBalance({ type: 'future' });
      return balance;
    } catch (error) {
      logger.error('Error fetching futures balance', error);
      throw new TradingError('Failed to fetch balance', 'BALANCE_ERROR');
    }
  }

  public async getFuturesPositions(): Promise<Position[]> {
    try {
      const positions = await this.exchange.fetchPositions();
      
      return positions
        .filter(pos => parseFloat(pos.contracts || '0') > 0)
        .map(pos => ({
          symbol: pos.symbol!,
          side: pos.side === 'long' ? 'LONG' : 'SHORT',
          size: parseFloat(pos.contracts || '0'),
          entryPrice: parseFloat(pos.entryPrice || '0'),
          markPrice: parseFloat(pos.markPrice || '0'),
          unrealizedPnl: parseFloat(pos.unrealizedPnl || '0'),
          leverage: parseInt(pos.info?.leverage || '1'),
          marginUsed: parseFloat(pos.info?.isolatedMargin || '0'),
          liquidationPrice: parseFloat(pos.info?.liquidationPrice || '0')
        }));
    } catch (error) {
      logger.error('Error fetching positions', error);
      throw new TradingError('Failed to fetch positions', 'POSITIONS_ERROR');
    }
  }

  // Market Data
  public async getMarketData(symbol: string): Promise<MarketData> {
    try {
      const [ticker, fundingRate] = await Promise.all([
        this.exchange.fetchTicker(symbol),
        this.getFundingRate(symbol)
      ]);

      return {
        symbol,
        price: ticker.last || 0,
        bidPrice: ticker.bid || 0,
        askPrice: ticker.ask || 0,
        volume24h: ticker.baseVolume || 0,
        priceChange24h: ticker.percentage || 0,
        fundingRate: fundingRate || 0,
        timestamp: Date.now(),
        openInterest: ticker.info?.openInterest ? parseFloat(ticker.info.openInterest) : undefined,
        markPrice: ticker.info?.markPrice ? parseFloat(ticker.info.markPrice) : undefined
      };
    } catch (error) {
      logger.error(`Error fetching market data for ${symbol}`, error);
      throw new TradingError(`Failed to fetch market data for ${symbol}`, 'MARKET_DATA_ERROR');
    }
  }

  public async getOrderBook(symbol: string, limit: number = 100): Promise<OrderBook> {
    try {
      const orderbook = await this.exchange.fetchOrderBook(symbol, limit);
      
      return {
        symbol,
        bids: orderbook.bids.map(([price, quantity]) => ({ price, quantity })),
        asks: orderbook.asks.map(([price, quantity]) => ({ price, quantity })),
        lastUpdateId: orderbook.nonce || Date.now(),
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`Error fetching order book for ${symbol}`, error);
      throw new TradingError(`Failed to fetch order book for ${symbol}`, 'ORDERBOOK_ERROR');
    }
  }

  public async getFundingRate(symbol: string): Promise<number> {
    try {
      const fundingRate = await this.exchange.fetchFundingRate(symbol);
      return fundingRate.fundingRate || 0;
    } catch (error) {
      logger.warn(`Error fetching funding rate for ${symbol}`, error);
      return 0;
    }
  }

  // Trading Operations
  public async createOrder(params: OrderParams): Promise<Order> {
    try {
      // Set leverage if provided
      if (params.leverage) {
        await this.setLeverage(params.symbol, params.leverage);
      }

      const orderParams: any = {
        symbol: params.symbol,
        type: params.type,
        side: params.side,
        amount: params.amount
      };

      if (params.price) orderParams.price = params.price;
      if (params.stopPrice) orderParams.stopPrice = params.stopPrice;
      if (params.timeInForce) orderParams.timeInForce = params.timeInForce;

      const order = await this.exchange.createOrder(
        params.symbol,
        params.type,
        params.side,
        params.amount,
        params.price,
        undefined,
        undefined,
        orderParams
      );

      const mappedOrder: Order = {
        id: order.id!,
        symbol: order.symbol!,
        side: order.side!.toUpperCase() as 'BUY' | 'SELL',
        type: order.type!.toUpperCase() as any,
        quantity: order.amount!,
        price: order.price,
        status: this.mapOrderStatus(order.status!),
        executedQty: order.filled || 0,
        averagePrice: order.average,
        createdAt: new Date(order.timestamp!),
        updatedAt: new Date(order.lastTradeTimestamp || order.timestamp!),
        binanceOrderId: parseInt(order.info?.orderId || '0')
      };

      logger.info('Order created successfully', {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        amount: params.amount,
        orderId: order.id
      });

      return mappedOrder;
    } catch (error) {
      logger.error('Error creating order', error, params);
      throw new TradingError('Failed to create order', 'ORDER_CREATE_ERROR');
    }
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      await this.exchange.cancelOrder(orderId, symbol);
      logger.info('Order cancelled successfully', { orderId, symbol });
      return true;
    } catch (error) {
      logger.error('Error cancelling order', error, { orderId, symbol });
      throw new TradingError('Failed to cancel order', 'ORDER_CANCEL_ERROR');
    }
  }

  public async getOrder(orderId: string, symbol: string): Promise<Order | null> {
    try {
      const order = await this.exchange.fetchOrder(orderId, symbol);
      
      return {
        id: order.id!,
        symbol: order.symbol!,
        side: order.side!.toUpperCase() as 'BUY' | 'SELL',
        type: order.type!.toUpperCase() as any,
        quantity: order.amount!,
        price: order.price,
        status: this.mapOrderStatus(order.status!),
        executedQty: order.filled || 0,
        averagePrice: order.average,
        createdAt: new Date(order.timestamp!),
        updatedAt: new Date(order.lastTradeTimestamp || order.timestamp!),
        binanceOrderId: parseInt(order.info?.orderId || '0')
      };
    } catch (error) {
      logger.error('Error fetching order', error, { orderId, symbol });
      return null;
    }
  }

  public async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol);
      
      return orders.map(order => ({
        id: order.id!,
        symbol: order.symbol!,
        side: order.side!.toUpperCase() as 'BUY' | 'SELL',
        type: order.type!.toUpperCase() as any,
        quantity: order.amount!,
        price: order.price,
        status: this.mapOrderStatus(order.status!),
        executedQty: order.filled || 0,
        averagePrice: order.average,
        createdAt: new Date(order.timestamp!),
        updatedAt: new Date(order.lastTradeTimestamp || order.timestamp!),
        binanceOrderId: parseInt(order.info?.orderId || '0')
      }));
    } catch (error) {
      logger.error('Error fetching open orders', error);
      throw new TradingError('Failed to fetch open orders', 'ORDERS_FETCH_ERROR');
    }
  }

  // Position Management
  public async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.exchange.setLeverage(leverage, symbol);
      logger.debug(`Leverage set to ${leverage}x for ${symbol}`);
    } catch (error) {
      logger.error(`Error setting leverage for ${symbol}`, error);
      throw new TradingError('Failed to set leverage', 'LEVERAGE_ERROR');
    }
  }

  public async closePosition(symbol: string): Promise<boolean> {
    try {
      const positions = await this.getFuturesPositions();
      const position = positions.find(pos => pos.symbol === symbol);
      
      if (!position || position.size === 0) {
        logger.info(`No position found for ${symbol}`);
        return true;
      }

      const side = position.side === 'LONG' ? 'sell' : 'buy';
      await this.createOrder({
        symbol,
        side,
        type: 'market',
        amount: position.size
      });

      logger.info(`Position closed for ${symbol}`, { size: position.size, side: position.side });
      return true;
    } catch (error) {
      logger.error(`Error closing position for ${symbol}`, error);
      throw new TradingError('Failed to close position', 'POSITION_CLOSE_ERROR');
    }
  }

  public async closeAllPositions(): Promise<boolean> {
    try {
      const positions = await this.getFuturesPositions();
      const openPositions = positions.filter(pos => pos.size > 0);

      if (openPositions.length === 0) {
        logger.info('No open positions to close');
        return true;
      }

      const closePromises = openPositions.map(position => 
        this.closePosition(position.symbol)
      );

      await Promise.all(closePromises);
      logger.info(`Closed ${openPositions.length} positions`);
      return true;
    } catch (error) {
      logger.error('Error closing all positions', error);
      throw new TradingError('Failed to close all positions', 'POSITIONS_CLOSE_ERROR');
    }
  }

  // WebSocket Connections
  public subscribeToMarketData(symbol: string, callback: (data: MarketData) => void): void {
    const wsUrl = 'wss://fstream.binance.com/ws';
    const stream = `${symbol.toLowerCase()}@ticker`;
    
    const ws = new WebSocket(`${wsUrl}/${stream}`);
    
    ws.on('open', () => {
      logger.info(`WebSocket connected for ${symbol} market data`);
      this.wsConnections.set(`market_${symbol}`, ws);
      this.marketDataCallbacks.set(symbol, callback);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        const marketData: MarketData = {
          symbol: parsed.s,
          price: parseFloat(parsed.c),
          bidPrice: parseFloat(parsed.b),
          askPrice: parseFloat(parsed.a),
          volume24h: parseFloat(parsed.v),
          priceChange24h: parseFloat(parsed.P),
          fundingRate: 0, // Will be updated separately
          timestamp: Date.now()
        };
        callback(marketData);
      } catch (error) {
        logger.error(`Error parsing market data for ${symbol}`, error);
      }
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket error for ${symbol}`, error);
      this.reconnectWebSocket(symbol, callback);
    });

    ws.on('close', () => {
      logger.warn(`WebSocket closed for ${symbol}`);
      this.reconnectWebSocket(symbol, callback);
    });
  }

  public subscribeToOrderBook(symbol: string, callback: (data: OrderBook) => void): void {
    const wsUrl = 'wss://fstream.binance.com/ws';
    const stream = `${symbol.toLowerCase()}@depth10@100ms`;
    
    const ws = new WebSocket(`${wsUrl}/${stream}`);
    
    ws.on('open', () => {
      logger.info(`WebSocket connected for ${symbol} order book`);
      this.wsConnections.set(`orderbook_${symbol}`, ws);
      this.orderBookCallbacks.set(symbol, callback);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        const orderBook: OrderBook = {
          symbol: parsed.s,
          bids: parsed.b.map(([price, quantity]: [string, string]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity)
          })),
          asks: parsed.a.map(([price, quantity]: [string, string]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity)
          })),
          lastUpdateId: parsed.u,
          timestamp: Date.now()
        };
        callback(orderBook);
      } catch (error) {
        logger.error(`Error parsing order book for ${symbol}`, error);
      }
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket error for ${symbol} order book`, error);
    });

    ws.on('close', () => {
      logger.warn(`WebSocket closed for ${symbol} order book`);
    });
  }

  private reconnectWebSocket(symbol: string, callback: (data: MarketData) => void): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnection attempts reached for ${symbol}`);
      return;
    }

    this.reconnectAttempts++;
    setTimeout(() => {
      logger.info(`Attempting to reconnect WebSocket for ${symbol} (attempt ${this.reconnectAttempts})`);
      this.subscribeToMarketData(symbol, callback);
    }, 5000 * this.reconnectAttempts);
  }

  public unsubscribeFromMarketData(symbol: string): void {
    const ws = this.wsConnections.get(`market_${symbol}`);
    if (ws) {
      ws.close();
      this.wsConnections.delete(`market_${symbol}`);
      this.marketDataCallbacks.delete(symbol);
      logger.info(`Unsubscribed from market data for ${symbol}`);
    }
  }

  public unsubscribeFromOrderBook(symbol: string): void {
    const ws = this.wsConnections.get(`orderbook_${symbol}`);
    if (ws) {
      ws.close();
      this.wsConnections.delete(`orderbook_${symbol}`);
      this.orderBookCallbacks.delete(symbol);
      logger.info(`Unsubscribed from order book for ${symbol}`);
    }
  }

  // Utility methods
  private mapOrderStatus(status: string): Order['status'] {
    const statusMap: Record<string, Order['status']> = {
      'open': 'NEW',
      'closed': 'FILLED',
      'canceled': 'CANCELED',
      'cancelled': 'CANCELED',
      'rejected': 'REJECTED',
      'expired': 'EXPIRED'
    };
    return statusMap[status.toLowerCase()] || 'NEW';
  }

  public async healthCheck(): Promise<boolean> {
    try {
      await this.exchange.fetchTime();
      return true;
    } catch (error) {
      logger.error('Binance API health check failed', error);
      return false;
    }
  }

  public isHealthy(): boolean {
    return this.isConnected;
  }

  public async disconnect(): Promise<void> {
    // Close all WebSocket connections
    for (const [key, ws] of this.wsConnections) {
      ws.close();
    }
    this.wsConnections.clear();
    this.marketDataCallbacks.clear();
    this.orderBookCallbacks.clear();
    
    this.isConnected = false;
    logger.info('Binance API disconnected');
  }
}

// Create singleton instance
export const binanceAPI = new BinanceAPI({
  apiKey: Config.BINANCE_KEY,
  secret: Config.BINANCE_SECRET,
  sandbox: Config.BINANCE_SANDBOX,
  testnet: Config.BINANCE_TESTNET
});

export default binanceAPI;