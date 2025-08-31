import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { Signal, MarketData, ServiceMessage, PerformanceMetrics, BacktestResult } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import Joi from 'joi';

interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  timeframes: string[];
  symbols: string[];
  parameters: Record<string, any>;
  weight: number; // For signal aggregation
}

interface TradingStrategy {
  id: string;
  name: string;
  analyze(marketData: MarketData[], config: StrategyConfig): Promise<Signal[]>;
  backtest?(historicalData: MarketData[], config: StrategyConfig): Promise<BacktestResult>;
}

interface SignalAggregation {
  symbol: string;
  signals: Signal[];
  aggregatedSignal: Signal | null;
  confidence: number;
  timestamp: number;
}

export class StrategyEngineService extends BaseService {
  private strategies: Map<string, TradingStrategy> = new Map();
  private strategyConfigs: Map<string, StrategyConfig> = new Map();
  private marketDataCache: Map<string, MarketData[]> = new Map();
  private currentSignals: Map<string, SignalAggregation> = new Map();
  private isAnalyzing: boolean = false;
  private analysisInterval: NodeJS.Timeout | null = null;

  constructor() {
    super('strategy-engine');
    this.setupRoutes();
    this.initializeStrategies();
  }

  protected async initialize(): Promise<void> {
    // Subscribe to market data updates
    await messageQueue.subscribe('trading.signals', this.handleCommand.bind(this));

    // Load strategy configurations
    await this.loadStrategyConfigurations();

    // Start signal generation
    await this.startSignalGeneration();

    this.logger.info('Strategy Engine Service initialized');
  }

  protected async cleanup(): Promise<void> {
    await this.stopSignalGeneration();
    this.logger.info('Strategy Engine Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();

    // Signal routes
    app.get('/api/signals/current', this.asyncHandler(this.getCurrentSignalsHandler.bind(this)));
    app.get('/api/signals/history', this.asyncHandler(this.getSignalHistoryHandler.bind(this)));
    app.post('/api/signals/generate/:symbol', this.asyncHandler(this.generateSignalHandler.bind(this)));

    // Strategy management routes
    app.get('/api/strategies', this.asyncHandler(this.getStrategiesHandler.bind(this)));
    app.post('/api/strategies/enable/:id', this.asyncHandler(this.enableStrategyHandler.bind(this)));
    app.post('/api/strategies/disable/:id', this.asyncHandler(this.disableStrategyHandler.bind(this)));
    app.put('/api/strategies/:id/config', this.asyncHandler(this.updateStrategyConfigHandler.bind(this)));
    app.get('/api/strategies/performance', this.asyncHandler(this.getPerformanceHandler.bind(this)));

    // Backtesting routes
    app.post('/api/backtest/:strategyId', this.asyncHandler(this.backtestHandler.bind(this)));
    app.get('/api/backtest/results/:strategyId', this.asyncHandler(this.getBacktestResultsHandler.bind(this)));
  }

  // Route Handlers
  private async getCurrentSignalsHandler(req: Request, res: Response): Promise<void> {
    const signals = Array.from(this.currentSignals.values()).map(agg => ({
      symbol: agg.symbol,
      signal: agg.aggregatedSignal,
      confidence: agg.confidence,
      individualSignals: agg.signals,
      timestamp: agg.timestamp
    }));

    this.sendResponse(res, true, signals);
  }

  private async getSignalHistoryHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, limit = 50, offset = 0 } = req.query;
      
      let query = 'SELECT * FROM ai_decisions WHERE recommendation != $1 ORDER BY timestamp DESC';
      const params = ['HOLD'];

      if (symbol) {
        query = 'SELECT * FROM ai_decisions WHERE recommendation != $1 AND market_conditions->\'symbol\' = $2 ORDER BY timestamp DESC';
        params.push(symbol as string);
      }

      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit as string, offset as string);

      const history = await db.query(query, params);
      this.sendResponse(res, true, history);
    } catch (error) {
      this.logger.error('Error fetching signal history', error);
      this.sendResponse(res, false, null, 'Failed to fetch signal history');
    }
  }

  private async generateSignalHandler(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const signals = await this.generateSignalsForSymbol(symbol);
      this.sendResponse(res, true, signals);
    } catch (error) {
      this.logger.error('Error generating signals', error);
      this.sendResponse(res, false, null, 'Failed to generate signals');
    }
  }

  private async getStrategiesHandler(req: Request, res: Response): Promise<void> {
    const strategies = Array.from(this.strategyConfigs.values()).map(config => ({
      ...config,
      performance: this.getStrategyPerformance(config.id)
    }));
    this.sendResponse(res, true, strategies);
  }

  private async enableStrategyHandler(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await this.enableStrategy(id);
      this.sendResponse(res, true, { message: `Strategy ${id} enabled` });
    } catch (error) {
      this.logger.error('Error enabling strategy', error);
      this.sendResponse(res, false, null, 'Failed to enable strategy');
    }
  }

  private async disableStrategyHandler(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await this.disableStrategy(id);
      this.sendResponse(res, true, { message: `Strategy ${id} disabled` });
    } catch (error) {
      this.logger.error('Error disabling strategy', error);
      this.sendResponse(res, false, null, 'Failed to disable strategy');
    }
  }

  private async updateStrategyConfigHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      parameters: Joi.object(),
      weight: Joi.number().min(0).max(1),
      symbols: Joi.array().items(Joi.string()),
      timeframes: Joi.array().items(Joi.string())
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { id } = req.params;
      await this.updateStrategyConfig(id, req.body);
      this.sendResponse(res, true, { message: `Strategy ${id} configuration updated` });
    } catch (error) {
      this.logger.error('Error updating strategy config', error);
      this.sendResponse(res, false, null, 'Failed to update strategy configuration');
    }
  }

  private async getPerformanceHandler(req: Request, res: Response): Promise<void> {
    try {
      const performance = await this.getAllStrategyPerformance();
      this.sendResponse(res, true, performance);
    } catch (error) {
      this.logger.error('Error fetching performance', error);
      this.sendResponse(res, false, null, 'Failed to fetch performance data');
    }
  }

  private async backtestHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      startDate: Joi.date().required(),
      endDate: Joi.date().required(),
      symbol: Joi.string(),
      parameters: Joi.object()
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { strategyId } = req.params;
      const result = await this.runBacktest(strategyId, req.body);
      this.sendResponse(res, true, result);
    } catch (error) {
      this.logger.error('Error running backtest', error);
      this.sendResponse(res, false, null, 'Failed to run backtest');
    }
  }

  private async getBacktestResultsHandler(req: Request, res: Response): Promise<void> {
    try {
      const { strategyId } = req.params;
      const results = await this.getBacktestResults(strategyId);
      this.sendResponse(res, true, results);
    } catch (error) {
      this.logger.error('Error fetching backtest results', error);
      this.sendResponse(res, false, null, 'Failed to fetch backtest results');
    }
  }

  // Command Handler
  private async handleCommand(message: ServiceMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'START_TRADING':
          await this.startSignalGeneration();
          break;
        case 'STOP_TRADING':
          await this.stopSignalGeneration();
          break;
        case 'PAUSE_TRADING':
          await this.pauseSignalGeneration();
          break;
        case 'CONFIG_UPDATE':
          await this.updateConfiguration(message.payload.config);
          break;
        case 'MARKET_DATA_UPDATE':
          await this.handleMarketDataUpdate(message.payload);
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

  // Strategy Initialization
  private initializeStrategies(): void {
    // Register built-in strategies
    this.strategies.set('momentum', new MomentumStrategy());
    this.strategies.set('mean-reversion', new MeanReversionStrategy());
    this.strategies.set('funding-arbitrage', new FundingArbitrageStrategy());

    this.logger.info('Trading strategies initialized', { 
      strategies: Array.from(this.strategies.keys()) 
    });
  }

  private async loadStrategyConfigurations(): Promise<void> {
    // Default strategy configurations
    const defaultConfigs: StrategyConfig[] = [
      {
        id: 'momentum',
        name: 'Momentum Strategy',
        enabled: true,
        timeframes: ['1m', '5m', '15m'],
        symbols: Config.TRADING_SYMBOLS,
        parameters: {
          rsiPeriod: 14,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 12,
          macdSlow: 26,
          macdSignal: 9,
          volumeThreshold: 1.5
        },
        weight: 0.4
      },
      {
        id: 'mean-reversion',
        name: 'Mean Reversion Strategy',
        enabled: true,
        timeframes: ['5m', '15m', '1h'],
        symbols: Config.TRADING_SYMBOLS,
        parameters: {
          bbPeriod: 20,
          bbStdDev: 2,
          rsiPeriod: 14,
          rsiExtreme: 80,
          volumeConfirmation: true
        },
        weight: 0.3
      },
      {
        id: 'funding-arbitrage',
        name: 'Funding Arbitrage Strategy',
        enabled: true,
        timeframes: ['8h'],
        symbols: Config.TRADING_SYMBOLS,
        parameters: {
          fundingThreshold: 0.01,
          maxHoldingTime: 8 * 60 * 60 * 1000, // 8 hours
          hedgeRatio: 0.95
        },
        weight: 0.3
      }
    ];

    for (const config of defaultConfigs) {
      this.strategyConfigs.set(config.id, config);
    }

    // Load from database if exists
    try {
      const saved = await redis.get('strategies:config');
      if (saved) {
        const savedConfigs = JSON.parse(saved);
        for (const config of savedConfigs) {
          this.strategyConfigs.set(config.id, config);
        }
      }
    } catch (error) {
      this.logger.warn('Could not load saved strategy configurations', error);
    }

    this.logger.info('Strategy configurations loaded');
  }

  // Signal Generation
  private async startSignalGeneration(): Promise<void> {
    if (this.isAnalyzing) return;

    this.isAnalyzing = true;

    // Start periodic analysis
    this.analysisInterval = setInterval(async () => {
      await this.performAnalysis();
    }, 30000); // Analyze every 30 seconds

    this.logger.info('Signal generation started');
  }

  private async stopSignalGeneration(): Promise<void> {
    if (!this.isAnalyzing) return;

    this.isAnalyzing = false;

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    this.logger.info('Signal generation stopped');
  }

  private async pauseSignalGeneration(): Promise<void> {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    this.logger.info('Signal generation paused');
  }

  private async performAnalysis(): Promise<void> {
    try {
      const symbols = Config.TRADING_SYMBOLS;

      for (const symbol of symbols) {
        await this.generateSignalsForSymbol(symbol);
      }

      this.logger.debug('Periodic analysis completed', { symbols: symbols.length });
    } catch (error) {
      this.logger.error('Error during periodic analysis', error);
    }
  }

  private async generateSignalsForSymbol(symbol: string): Promise<SignalAggregation> {
    try {
      // Get recent market data
      const marketData = await this.getMarketDataForSymbol(symbol);
      if (!marketData || marketData.length === 0) {
        this.logger.warn(`No market data available for ${symbol}`);
        return { symbol, signals: [], aggregatedSignal: null, confidence: 0, timestamp: Date.now() };
      }

      const signals: Signal[] = [];

      // Generate signals from each enabled strategy
      for (const [strategyId, config] of this.strategyConfigs) {
        if (!config.enabled || !config.symbols.includes(symbol)) continue;

        const strategy = this.strategies.get(strategyId);
        if (!strategy) continue;

        try {
          const strategySignals = await strategy.analyze(marketData, config);
          signals.push(...strategySignals);
        } catch (error) {
          this.logger.error(`Error in strategy ${strategyId}`, error, { symbol });
        }
      }

      // Aggregate signals
      const aggregation = this.aggregateSignals(symbol, signals);

      // Cache current signals
      this.currentSignals.set(symbol, aggregation);

      // Publish significant signals
      if (aggregation.aggregatedSignal && aggregation.confidence > 60) {
        await messageQueue.publishSignal(aggregation.aggregatedSignal);
        
        this.logger.info('Signal generated', {
          symbol,
          action: aggregation.aggregatedSignal.action,
          confidence: aggregation.confidence,
          strategies: signals.length
        });
      }

      return aggregation;
    } catch (error) {
      this.logger.error(`Error generating signals for ${symbol}`, error);
      return { symbol, signals: [], aggregatedSignal: null, confidence: 0, timestamp: Date.now() };
    }
  }

  private aggregateSignals(symbol: string, signals: Signal[]): SignalAggregation {
    if (signals.length === 0) {
      return { symbol, signals, aggregatedSignal: null, confidence: 0, timestamp: Date.now() };
    }

    // Group signals by action
    const groupedSignals = signals.reduce((groups, signal) => {
      if (!groups[signal.action]) groups[signal.action] = [];
      groups[signal.action].push(signal);
      return groups;
    }, {} as Record<string, Signal[]>);

    // Calculate weighted scores for each action
    const actionScores: Record<string, number> = {};
    for (const [action, actionSignals] of Object.entries(groupedSignals)) {
      actionScores[action] = actionSignals.reduce((score, signal) => {
        const strategy = this.strategyConfigs.get(signal.strategy);
        const weight = strategy?.weight || 0.33;
        return score + (signal.confidence * weight);
      }, 0);
    }

    // Find the action with highest score
    const bestAction = Object.keys(actionScores).reduce((a, b) => 
      actionScores[a] > actionScores[b] ? a : b
    );

    const bestScore = actionScores[bestAction];
    const maxPossibleScore = Array.from(this.strategyConfigs.values())
      .filter(config => config.enabled && config.symbols.includes(symbol))
      .reduce((sum, config) => sum + (config.weight * 100), 0);

    const confidence = Math.min(100, (bestScore / maxPossibleScore) * 100);

    // Create aggregated signal if confidence is high enough
    let aggregatedSignal: Signal | null = null;
    if (confidence > 50 && bestAction !== 'HOLD') {
      const bestSignals = groupedSignals[bestAction];
      aggregatedSignal = {
        symbol,
        action: bestAction as any,
        confidence,
        reasoning: `Aggregated from ${bestSignals.length} strategies: ${bestSignals.map(s => s.strategy).join(', ')}`,
        strategy: 'aggregated',
        timestamp: Date.now()
      };

      // Use average target price and stop loss from contributing signals
      const validSignals = bestSignals.filter(s => s.targetPrice);
      if (validSignals.length > 0) {
        aggregatedSignal.targetPrice = validSignals.reduce((sum, s) => sum + (s.targetPrice || 0), 0) / validSignals.length;
      }

      const validStops = bestSignals.filter(s => s.stopLoss);
      if (validStops.length > 0) {
        aggregatedSignal.stopLoss = validStops.reduce((sum, s) => sum + (s.stopLoss || 0), 0) / validStops.length;
      }
    }

    return {
      symbol,
      signals,
      aggregatedSignal,
      confidence,
      timestamp: Date.now()
    };
  }

  // Market Data Management
  private async handleMarketDataUpdate(payload: any): Promise<void> {
    const { symbol, data } = payload;
    
    if (!this.marketDataCache.has(symbol)) {
      this.marketDataCache.set(symbol, []);
    }

    const cache = this.marketDataCache.get(symbol)!;
    cache.push(data);

    // Keep only last 100 data points
    if (cache.length > 100) {
      cache.shift();
    }
  }

  private async getMarketDataForSymbol(symbol: string): Promise<MarketData[]> {
    // Try cache first
    let marketData = this.marketDataCache.get(symbol);
    
    if (!marketData || marketData.length < 10) {
      // Fetch from Redis if cache is insufficient
      const cached = await redis.getMarketData<MarketData>(symbol);
      if (cached) {
        marketData = [cached];
        this.marketDataCache.set(symbol, marketData);
      }
    }

    return marketData || [];
  }

  // Strategy Management
  private async enableStrategy(strategyId: string): Promise<void> {
    const config = this.strategyConfigs.get(strategyId);
    if (config) {
      config.enabled = true;
      await this.saveStrategyConfigurations();
      this.logger.info(`Strategy ${strategyId} enabled`);
    }
  }

  private async disableStrategy(strategyId: string): Promise<void> {
    const config = this.strategyConfigs.get(strategyId);
    if (config) {
      config.enabled = false;
      await this.saveStrategyConfigurations();
      this.logger.info(`Strategy ${strategyId} disabled`);
    }
  }

  private async updateStrategyConfig(strategyId: string, updates: Partial<StrategyConfig>): Promise<void> {
    const config = this.strategyConfigs.get(strategyId);
    if (config) {
      Object.assign(config, updates);
      await this.saveStrategyConfigurations();
      this.logger.info(`Strategy ${strategyId} configuration updated`, updates);
    }
  }

  private async saveStrategyConfigurations(): Promise<void> {
    const configs = Array.from(this.strategyConfigs.values());
    await redis.set('strategies:config', JSON.stringify(configs));
  }

  // Performance Tracking
  private getStrategyPerformance(strategyId: string): PerformanceMetrics {
    // This would calculate actual performance metrics
    // For now, return placeholder data
    return {
      totalReturn: 0,
      dailyReturn: 0,
      weeklyReturn: 0,
      monthlyReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      totalTrades: 0
    };
  }

  private async getAllStrategyPerformance(): Promise<Record<string, PerformanceMetrics>> {
    const performance: Record<string, PerformanceMetrics> = {};
    
    for (const strategyId of this.strategyConfigs.keys()) {
      performance[strategyId] = this.getStrategyPerformance(strategyId);
    }

    return performance;
  }

  // Backtesting
  private async runBacktest(strategyId: string, params: any): Promise<BacktestResult> {
    // This would run actual backtesting
    // For now, return placeholder result
    return {
      totalReturn: 15.5,
      sharpeRatio: 1.2,
      maxDrawdown: -8.3,
      winRate: 65.4,
      profitFactor: 1.8,
      totalTrades: 156
    };
  }

  private async getBacktestResults(strategyId: string): Promise<BacktestResult[]> {
    // This would fetch stored backtest results
    return [];
  }

  // Utility Methods
  private async updateConfiguration(config: any): Promise<void> {
    // Handle configuration updates
    this.logger.info('Configuration updated', config);
  }

  private async emergencyStop(): Promise<void> {
    await this.stopSignalGeneration();
    this.currentSignals.clear();
    this.logger.warn('Emergency stop - signal generation halted');
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      isAnalyzing: this.isAnalyzing,
      enabledStrategies: Array.from(this.strategyConfigs.values()).filter(c => c.enabled).length,
      totalStrategies: this.strategyConfigs.size,
      activeSignals: this.currentSignals.size,
      avgConfidence: Array.from(this.currentSignals.values()).reduce((sum, agg) => sum + agg.confidence, 0) / this.currentSignals.size || 0
    };
  }
}

// Strategy Implementations (Simplified)
class MomentumStrategy implements TradingStrategy {
  id = 'momentum';
  name = 'Momentum Strategy';

  async analyze(marketData: MarketData[], config: StrategyConfig): Promise<Signal[]> {
    if (marketData.length < 20) return [];

    const signals: Signal[] = [];
    const latest = marketData[marketData.length - 1];

    // Simple momentum based on price change and RSI
    const priceChange = ((latest.price - marketData[marketData.length - 10].price) / marketData[marketData.length - 10].price) * 100;
    
    if (priceChange > 2) {
      signals.push({
        symbol: latest.symbol,
        action: 'BUY',
        confidence: Math.min(80, 60 + Math.abs(priceChange)),
        reasoning: `Strong upward momentum: ${priceChange.toFixed(2)}% price increase`,
        strategy: this.id,
        timestamp: Date.now()
      });
    } else if (priceChange < -2) {
      signals.push({
        symbol: latest.symbol,
        action: 'SELL',
        confidence: Math.min(80, 60 + Math.abs(priceChange)),
        reasoning: `Strong downward momentum: ${priceChange.toFixed(2)}% price decrease`,
        strategy: this.id,
        timestamp: Date.now()
      });
    }

    return signals;
  }
}

class MeanReversionStrategy implements TradingStrategy {
  id = 'mean-reversion';
  name = 'Mean Reversion Strategy';

  async analyze(marketData: MarketData[], config: StrategyConfig): Promise<Signal[]> {
    if (marketData.length < 20) return [];

    const signals: Signal[] = [];
    const latest = marketData[marketData.length - 1];

    // Simple mean reversion based on deviation from moving average
    const prices = marketData.slice(-20).map(d => d.price);
    const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const deviation = ((latest.price - average) / average) * 100;

    if (deviation > 3) {
      signals.push({
        symbol: latest.symbol,
        action: 'SELL',
        confidence: Math.min(75, 50 + Math.abs(deviation) * 2),
        reasoning: `Price ${deviation.toFixed(2)}% above 20-period average - reversion expected`,
        strategy: this.id,
        timestamp: Date.now()
      });
    } else if (deviation < -3) {
      signals.push({
        symbol: latest.symbol,
        action: 'BUY',
        confidence: Math.min(75, 50 + Math.abs(deviation) * 2),
        reasoning: `Price ${Math.abs(deviation).toFixed(2)}% below 20-period average - reversion expected`,
        strategy: this.id,
        timestamp: Date.now()
      });
    }

    return signals;
  }
}

class FundingArbitrageStrategy implements TradingStrategy {
  id = 'funding-arbitrage';
  name = 'Funding Arbitrage Strategy';

  async analyze(marketData: MarketData[], config: StrategyConfig): Promise<Signal[]> {
    if (marketData.length < 1) return [];

    const signals: Signal[] = [];
    const latest = marketData[marketData.length - 1];

    // Simple funding rate arbitrage
    if (latest.fundingRate > 0.01) { // 1% funding rate
      signals.push({
        symbol: latest.symbol,
        action: 'SELL',
        confidence: 70,
        reasoning: `High positive funding rate: ${(latest.fundingRate * 100).toFixed(3)}% - short to collect funding`,
        strategy: this.id,
        timestamp: Date.now()
      });
    } else if (latest.fundingRate < -0.005) { // -0.5% funding rate
      signals.push({
        symbol: latest.symbol,
        action: 'BUY',
        confidence: 70,
        reasoning: `High negative funding rate: ${(latest.fundingRate * 100).toFixed(3)}% - long to collect funding`,
        strategy: this.id,
        timestamp: Date.now()
      });
    }

    return signals;
  }
}

export default StrategyEngineService;