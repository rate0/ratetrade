import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { MarketData, OrderBook, ServiceMessage } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { binanceAPI } from '@/utils/binance';
import Joi from 'joi';

interface MarketDataSubscription {
  symbol: string;
  subscriptions: Set<string>; // Types: 'ticker', 'orderbook', 'trades'
  lastUpdate: number;
}

interface MarketSnapshot {
  timestamp: number;
  data: Record<string, MarketData>;
  volatility: Record<string, number>;
  trends: Record<string, 'BULLISH' | 'BEARISH' | 'SIDEWAYS'>;
}

export class MarketDataService extends BaseService {
  private subscriptions: Map<string, MarketDataSubscription> = new Map();
  private priceHistory: Map<string, number[]> = new Map();
  private isCollecting: boolean = false;
  private marketSnapshot: MarketSnapshot = {
    timestamp: 0,
    data: {},
    volatility: {},
    trends: {}
  };
  private updateInterval: NodeJS.Timeout | null = null;

  constructor() {
    super('market-data');
    this.setupRoutes();
  }

  protected async initialize(): Promise<void> {
    // Initialize Binance API
    await binanceAPI.initialize();

    // Subscribe to orchestrator commands
    await messageQueue.subscribe('market.data', this.handleCommand.bind(this));

    // Setup market data collection for configured symbols
    await this.setupMarketDataCollection();

    this.logger.info('Market Data Service initialized');
  }

  protected async cleanup(): Promise<void> {
    await this.stopDataCollection();
    await binanceAPI.disconnect();
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.logger.info('Market Data Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();

    // Market data routes
    app.get('/api/market/ticker/:symbol', this.asyncHandler(this.getTickerHandler.bind(this)));
    app.get('/api/market/orderbook/:symbol', this.asyncHandler(this.getOrderBookHandler.bind(this)));
    app.get('/api/market/trades/:symbol', this.asyncHandler(this.getTradesHandler.bind(this)));
    app.get('/api/market/snapshot', this.asyncHandler(this.getSnapshotHandler.bind(this)));

    // Historical data routes
    app.get('/api/market/klines/:symbol', this.asyncHandler(this.getKlinesHandler.bind(this)));
    app.get('/api/market/funding/:symbol', this.asyncHandler(this.getFundingHandler.bind(this)));

    // Market analysis routes
    app.get('/api/market/volatility/:symbol', this.asyncHandler(this.getVolatilityHandler.bind(this)));
    app.get('/api/market/trends', this.asyncHandler(this.getTrendsHandler.bind(this)));

    // Subscription management
    app.post('/api/market/subscribe', this.asyncHandler(this.subscribeHandler.bind(this)));
    app.post('/api/market/unsubscribe', this.asyncHandler(this.unsubscribeHandler.bind(this)));
    app.get('/api/market/subscriptions', this.asyncHandler(this.getSubscriptionsHandler.bind(this)));
  }

  // Route Handlers
  private async getTickerHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      
      // Try to get from cache first
      let marketData = await redis.getMarketData<MarketData>(symbol);
      
      if (!marketData) {
        // Fetch fresh data if not in cache
        marketData = await binanceAPI.getMarketData(symbol);
        await redis.cacheMarketData(symbol, marketData, 30);
      }

      this.sendResponse(res, true, marketData);
    } catch (error) {
      this.logger.error('Error fetching ticker', error);
      this.sendResponse(res, false, null, 'Failed to fetch ticker data');
    }
  }

  private async getOrderBookHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      
      const orderBook = await binanceAPI.getOrderBook(symbol, limit);
      this.sendResponse(res, true, orderBook);
    } catch (error) {
      this.logger.error('Error fetching order book', error);
      this.sendResponse(res, false, null, 'Failed to fetch order book');
    }
  }

  private async getTradesHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      
      // This would fetch recent trades from Binance
      // For now, return empty array as placeholder
      this.sendResponse(res, true, []);
    } catch (error) {
      this.logger.error('Error fetching trades', error);
      this.sendResponse(res, false, null, 'Failed to fetch trades');
    }
  }

  private async getSnapshotHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.marketSnapshot);
  }

  private async getKlinesHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { timeframe = '1m', limit = 100 } = req.query;
      
      // This would fetch historical klines from Binance
      // For now, return empty array as placeholder
      this.sendResponse(res, true, []);
    } catch (error) {
      this.logger.error('Error fetching klines', error);
      this.sendResponse(res, false, null, 'Failed to fetch klines');
    }
  }

  private async getFundingHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const fundingRate = await binanceAPI.getFundingRate(symbol);
      this.sendResponse(res, true, { symbol, fundingRate });
    } catch (error) {
      this.logger.error('Error fetching funding rate', error);
      this.sendResponse(res, false, null, 'Failed to fetch funding rate');
    }
  }

  private async getVolatilityHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const volatility = this.calculateVolatility(symbol);
      this.sendResponse(res, true, { symbol, volatility });
    } catch (error) {
      this.logger.error('Error calculating volatility', error);
      this.sendResponse(res, false, null, 'Failed to calculate volatility');
    }
  }

  private async getTrendsHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.marketSnapshot.trends);
  }

  private async subscribeHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      symbol: Joi.string().required(),
      types: Joi.array().items(Joi.string().valid('ticker', 'orderbook', 'trades')).default(['ticker'])
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { symbol, types } = req.body;
      await this.subscribeToSymbol(symbol, types);
      this.sendResponse(res, true, { symbol, types });
    } catch (error) {
      this.logger.error('Error subscribing to market data', error);
      this.sendResponse(res, false, null, 'Failed to subscribe');
    }
  }

  private async unsubscribeHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      symbol: Joi.string().required(),
      types: Joi.array().items(Joi.string().valid('ticker', 'orderbook', 'trades'))
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { symbol, types } = req.body;
      await this.unsubscribeFromSymbol(symbol, types);
      this.sendResponse(res, true, { symbol, types });
    } catch (error) {
      this.logger.error('Error unsubscribing from market data', error);
      this.sendResponse(res, false, null, 'Failed to unsubscribe');
    }
  }

  private async getSubscriptionsHandler(req: Request, res: Response): Promise<void> {
    const subscriptions = Array.from(this.subscriptions.entries()).map(([symbol, sub]) => ({
      symbol,
      subscriptions: Array.from(sub.subscriptions),
      lastUpdate: sub.lastUpdate
    }));
    this.sendResponse(res, true, subscriptions);
  }

  // Command Handler
  private async handleCommand(message: ServiceMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'START_TRADING':
          await this.startDataCollection();
          break;
        case 'STOP_TRADING':
          await this.stopDataCollection();
          break;
        case 'PAUSE_TRADING':
          await this.pauseDataCollection();
          break;
        case 'CONFIG_UPDATE':
          await this.updateConfiguration(message.payload.config);
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

  // Market Data Collection
  private async setupMarketDataCollection(): Promise<void> {
    const symbols = Config.TRADING_SYMBOLS;
    
    for (const symbol of symbols) {
      await this.subscribeToSymbol(symbol, ['ticker']);
    }

    // Start periodic snapshot updates
    this.updateInterval = setInterval(() => {
      this.updateMarketSnapshot();
    }, 10000); // Update every 10 seconds

    this.logger.info('Market data collection setup completed', { symbols: symbols.length });
  }

  private async subscribeToSymbol(symbol: string, types: string[]): Promise<void> {
    if (!this.subscriptions.has(symbol)) {
      this.subscriptions.set(symbol, {
        symbol,
        subscriptions: new Set(),
        lastUpdate: Date.now()
      });
    }

    const subscription = this.subscriptions.get(symbol)!;

    for (const type of types) {
      if (!subscription.subscriptions.has(type)) {
        subscription.subscriptions.add(type);

        switch (type) {
          case 'ticker':
            await this.subscribeToTicker(symbol);
            break;
          case 'orderbook':
            await this.subscribeToOrderBook(symbol);
            break;
          case 'trades':
            await this.subscribeToTrades(symbol);
            break;
        }
      }
    }

    this.logger.info(`Subscribed to ${symbol}`, { types });
  }

  private async unsubscribeFromSymbol(symbol: string, types?: string[]): Promise<void> {
    const subscription = this.subscriptions.get(symbol);
    if (!subscription) return;

    const typesToRemove = types || Array.from(subscription.subscriptions);

    for (const type of typesToRemove) {
      if (subscription.subscriptions.has(type)) {
        subscription.subscriptions.delete(type);

        switch (type) {
          case 'ticker':
            binanceAPI.unsubscribeFromMarketData(symbol);
            break;
          case 'orderbook':
            binanceAPI.unsubscribeFromOrderBook(symbol);
            break;
        }
      }
    }

    if (subscription.subscriptions.size === 0) {
      this.subscriptions.delete(symbol);
    }

    this.logger.info(`Unsubscribed from ${symbol}`, { types: typesToRemove });
  }

  private async subscribeToTicker(symbol: string): Promise<void> {
    binanceAPI.subscribeToMarketData(symbol, async (data: MarketData) => {
      await this.handleMarketDataUpdate(data);
    });
  }

  private async subscribeToOrderBook(symbol: string): Promise<void> {
    binanceAPI.subscribeToOrderBook(symbol, async (orderBook: OrderBook) => {
      await this.handleOrderBookUpdate(orderBook);
    });
  }

  private async subscribeToTrades(symbol: string): Promise<void> {
    // Implementation for trade stream subscription
    // This would subscribe to individual trade updates
  }

  // Data Handlers
  private async handleMarketDataUpdate(data: MarketData): Promise<void> {
    try {
      // Cache the data
      await redis.cacheMarketData(data.symbol, data, 30);

      // Update price history for volatility calculation
      this.updatePriceHistory(data.symbol, data.price);

      // Update market snapshot
      this.marketSnapshot.data[data.symbol] = data;
      this.marketSnapshot.timestamp = Date.now();

      // Calculate volatility and trend
      this.marketSnapshot.volatility[data.symbol] = this.calculateVolatility(data.symbol);
      this.marketSnapshot.trends[data.symbol] = this.calculateTrend(data.symbol);

      // Publish to message queue for other services
      await messageQueue.publishMarketData(data.symbol, data);

      // Update subscription timestamp
      const subscription = this.subscriptions.get(data.symbol);
      if (subscription) {
        subscription.lastUpdate = Date.now();
      }
    } catch (error) {
      this.logger.error('Error handling market data update', error, { symbol: data.symbol });
    }
  }

  private async handleOrderBookUpdate(orderBook: OrderBook): Promise<void> {
    try {
      // Cache order book data
      await redis.set(`orderbook:${orderBook.symbol}`, orderBook, 30);

      // Publish to message queue
      await messageQueue.publish('trading', `orderbook.${orderBook.symbol.toLowerCase()}`, {
        type: 'ORDERBOOK_UPDATE',
        payload: orderBook,
        timestamp: Date.now(),
        source: 'market-data-service'
      });
    } catch (error) {
      this.logger.error('Error handling order book update', error, { symbol: orderBook.symbol });
    }
  }

  // Analysis Methods
  private updatePriceHistory(symbol: string, price: number): void {
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }

    const history = this.priceHistory.get(symbol)!;
    history.push(price);

    // Keep only last 100 prices for volatility calculation
    if (history.length > 100) {
      history.shift();
    }
  }

  private calculateVolatility(symbol: string): number {
    const history = this.priceHistory.get(symbol);
    if (!history || history.length < 2) return 0;

    // Calculate simple volatility as standard deviation of price changes
    const changes = [];
    for (let i = 1; i < history.length; i++) {
      changes.push((history[i] - history[i - 1]) / history[i - 1]);
    }

    if (changes.length === 0) return 0;

    const mean = changes.reduce((sum, change) => sum + change, 0) / changes.length;
    const variance = changes.reduce((sum, change) => sum + Math.pow(change - mean, 2), 0) / changes.length;
    
    return Math.sqrt(variance) * 100; // Return as percentage
  }

  private calculateTrend(symbol: string): 'BULLISH' | 'BEARISH' | 'SIDEWAYS' {
    const history = this.priceHistory.get(symbol);
    if (!history || history.length < 10) return 'SIDEWAYS';

    // Simple trend calculation based on price direction over last 10 data points
    const recent = history.slice(-10);
    const firstPrice = recent[0];
    const lastPrice = recent[recent.length - 1];
    const change = (lastPrice - firstPrice) / firstPrice;

    if (change > 0.005) return 'BULLISH'; // > 0.5% increase
    if (change < -0.005) return 'BEARISH'; // > 0.5% decrease
    return 'SIDEWAYS';
  }

  private async updateMarketSnapshot(): Promise<void> {
    try {
      // Update trends and volatility for all symbols
      for (const symbol of Object.keys(this.marketSnapshot.data)) {
        this.marketSnapshot.volatility[symbol] = this.calculateVolatility(symbol);
        this.marketSnapshot.trends[symbol] = this.calculateTrend(symbol);
      }

      this.marketSnapshot.timestamp = Date.now();

      // Cache the snapshot
      await redis.set('market:snapshot', this.marketSnapshot, 60);

      this.logger.debug('Market snapshot updated', {
        symbols: Object.keys(this.marketSnapshot.data).length,
        avgVolatility: Object.values(this.marketSnapshot.volatility).reduce((sum, vol) => sum + vol, 0) / Object.keys(this.marketSnapshot.volatility).length
      });
    } catch (error) {
      this.logger.error('Error updating market snapshot', error);
    }
  }

  // Control Methods
  private async startDataCollection(): Promise<void> {
    if (this.isCollecting) return;

    this.isCollecting = true;
    await this.setupMarketDataCollection();
    this.logger.info('Market data collection started');
  }

  private async stopDataCollection(): Promise<void> {
    if (!this.isCollecting) return;

    this.isCollecting = false;

    // Unsubscribe from all symbols
    for (const symbol of this.subscriptions.keys()) {
      await this.unsubscribeFromSymbol(symbol);
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.logger.info('Market data collection stopped');
  }

  private async pauseDataCollection(): Promise<void> {
    // For market data, pause means stop collecting but keep subscriptions
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.logger.info('Market data collection paused');
  }

  private async updateConfiguration(config: any): Promise<void> {
    // Handle configuration updates
    this.logger.info('Configuration updated', config);
  }

  private async emergencyStop(): Promise<void> {
    await this.stopDataCollection();
    this.logger.warn('Emergency stop - market data collection halted');
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      subscriptions: this.subscriptions.size,
      isCollecting: this.isCollecting,
      marketDataAge: Date.now() - this.marketSnapshot.timestamp,
      avgVolatility: Object.keys(this.marketSnapshot.volatility).length > 0 
        ? Object.values(this.marketSnapshot.volatility).reduce((sum, vol) => sum + vol, 0) / Object.keys(this.marketSnapshot.volatility).length
        : 0
    };
  }
}

export default MarketDataService;