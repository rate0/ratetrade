import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { AIDecisionCriteria, AIRecommendation, MarketData, ServiceMessage, Signal } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import OpenAI from 'openai';
import Joi from 'joi';

interface AIConfig {
  enabled: boolean;
  volatilityThreshold: number;
  confidenceThreshold: number;
  usageCostLimit: number;
  cooldownPeriod: number;
  maxRequestsPerHour: number;
}

interface AIUsageStats {
  hourlyRequests: number;
  hourlyCost: number;
  totalRequests: number;
  totalCost: number;
  lastRequest: Date;
  lastReset: Date;
}

interface MarketConditions {
  volatility: Record<string, number>;
  trends: Record<string, 'BULLISH' | 'BEARISH' | 'SIDEWAYS'>;
  sentiment: number;
  anomalies: string[];
  correlations: Record<string, number>;
}

export class AIAdvisorService extends BaseService {
  private openai: OpenAI | null = null;
  private config: AIConfig;
  private usageStats: AIUsageStats;
  private marketConditions: MarketConditions = {
    volatility: {},
    trends: {},
    sentiment: 0,
    anomalies: [],
    correlations: {}
  };
  private isAnalyzing: boolean = false;
  private analysisInterval: NodeJS.Timeout | null = null;
  private requestQueue: Array<{ resolve: Function; reject: Function; prompt: string }> = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    super('ai-advisor');
    
    this.config = {
      enabled: !!Config.OPENAI_API_KEY,
      volatilityThreshold: Config.AI_VOLATILITY_THRESHOLD,
      confidenceThreshold: Config.AI_CONFIDENCE_THRESHOLD,
      usageCostLimit: Config.AI_USAGE_COST_LIMIT,
      cooldownPeriod: 300000, // 5 minutes
      maxRequestsPerHour: 20
    };

    this.usageStats = {
      hourlyRequests: 0,
      hourlyCost: 0,
      totalRequests: 0,
      totalCost: 0,
      lastRequest: new Date(0),
      lastReset: new Date()
    };

    this.setupRoutes();
    this.initializeOpenAI();
  }

  protected async initialize(): Promise<void> {
    await messageQueue.subscribe('ai.decisions', this.handleCommand.bind(this));
    await this.loadUsageStats();
    await this.startAIAnalysis();
    
    this.logger.info('AI Advisor Service initialized', { 
      enabled: this.config.enabled,
      model: Config.OPENAI_MODEL 
    });
  }

  protected async cleanup(): Promise<void> {
    await this.stopAIAnalysis();
    await this.saveUsageStats();
    this.logger.info('AI Advisor Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();

    // AI analysis routes
    app.post('/api/ai/analyze', this.asyncHandler(this.analyzeMarketHandler.bind(this)));
    app.post('/api/ai/recommendation', this.asyncHandler(this.getRecommendationHandler.bind(this)));
    app.get('/api/ai/decisions/history', this.asyncHandler(this.getDecisionHistoryHandler.bind(this)));

    // Configuration routes
    app.get('/api/ai/config', this.asyncHandler(this.getConfigHandler.bind(this)));
    app.put('/api/ai/config', this.asyncHandler(this.updateConfigHandler.bind(this)));
    app.get('/api/ai/usage', this.asyncHandler(this.getUsageStatsHandler.bind(this)));
    app.post('/api/ai/usage/reset', this.asyncHandler(this.resetUsageStatsHandler.bind(this)));

    // Market conditions routes
    app.get('/api/ai/market-conditions', this.asyncHandler(this.getMarketConditionsHandler.bind(this)));
    app.get('/api/ai/anomalies', this.asyncHandler(this.getAnomaliesHandler.bind(this)));
  }

  // Route Handlers
  private async analyzeMarketHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      symbols: Joi.array().items(Joi.string()).default(Config.TRADING_SYMBOLS),
      prompt: Joi.string().max(500),
      forceAnalysis: Joi.boolean().default(false)
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const { symbols, prompt, forceAnalysis } = req.body;
      const analysis = await this.analyzeMarket(symbols, prompt, forceAnalysis);
      this.sendResponse(res, true, analysis);
    } catch (error) {
      this.logger.error('Error analyzing market', error);
      this.sendResponse(res, false, null, 'Failed to analyze market');
    }
  }

  private async getRecommendationHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      signals: Joi.array().items(Joi.object()).required(),
      marketData: Joi.object().required(),
      riskLevel: Joi.string().valid('LOW', 'MEDIUM', 'HIGH', 'CRITICAL').required()
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const recommendation = await this.getTradeRecommendation(
        req.body.signals,
        req.body.marketData,
        req.body.riskLevel
      );
      this.sendResponse(res, true, recommendation);
    } catch (error) {
      this.logger.error('Error getting recommendation', error);
      this.sendResponse(res, false, null, 'Failed to get recommendation');
    }
  }

  private async getDecisionHistoryHandler(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 50, offset = 0 } = req.query;
      
      const history = await db.query(
        'SELECT * FROM ai_decisions ORDER BY timestamp DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );

      this.sendResponse(res, true, history);
    } catch (error) {
      this.logger.error('Error fetching decision history', error);
      this.sendResponse(res, false, null, 'Failed to fetch decision history');
    }
  }

  private async getConfigHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.config);
  }

  private async updateConfigHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      enabled: Joi.boolean(),
      volatilityThreshold: Joi.number().min(0).max(100),
      confidenceThreshold: Joi.number().min(0).max(100),
      usageCostLimit: Joi.number().min(0),
      maxRequestsPerHour: Joi.number().min(1).max(100)
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      this.config = { ...this.config, ...req.body };
      await this.saveConfig();
      this.sendResponse(res, true, this.config);
    } catch (error) {
      this.logger.error('Error updating config', error);
      this.sendResponse(res, false, null, 'Failed to update config');
    }
  }

  private async getUsageStatsHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.usageStats);
  }

  private async resetUsageStatsHandler(req: Request, res: Response): Promise<void> {
    this.usageStats = {
      hourlyRequests: 0,
      hourlyCost: 0,
      totalRequests: this.usageStats.totalRequests,
      totalCost: this.usageStats.totalCost,
      lastRequest: this.usageStats.lastRequest,
      lastReset: new Date()
    };

    await this.saveUsageStats();
    this.sendResponse(res, true, this.usageStats);
  }

  private async getMarketConditionsHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.marketConditions);
  }

  private async getAnomaliesHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, { anomalies: this.marketConditions.anomalies });
  }

  // Command Handler
  private async handleCommand(message: ServiceMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'START_TRADING':
          await this.startAIAnalysis();
          break;
        case 'STOP_TRADING':
          await this.stopAIAnalysis();
          break;
        case 'TRADING_SIGNAL':
          await this.evaluateSignal(message.payload);
          break;
        case 'MARKET_DATA_UPDATE':
          await this.updateMarketConditions(message.payload);
          break;
        case 'RISK_UPDATE':
          await this.evaluateRiskConditions(message.payload);
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

  // OpenAI Initialization
  private initializeOpenAI(): void {
    if (!Config.OPENAI_API_KEY) {
      this.logger.warn('OpenAI API key not provided, AI features disabled');
      this.config.enabled = false;
      return;
    }

    try {
      this.openai = new OpenAI({
        apiKey: Config.OPENAI_API_KEY
      });
      this.logger.info('OpenAI client initialized');
    } catch (error) {
      this.logger.error('Failed to initialize OpenAI client', error);
      this.config.enabled = false;
    }
  }

  // AI Analysis
  private async startAIAnalysis(): Promise<void> {
    if (this.isAnalyzing || !this.config.enabled) return;

    this.isAnalyzing = true;

    // Start periodic market analysis
    this.analysisInterval = setInterval(async () => {
      await this.performPeriodicAnalysis();
    }, 600000); // Every 10 minutes

    // Start processing request queue
    this.processRequestQueue();

    this.logger.info('AI analysis started');
  }

  private async stopAIAnalysis(): Promise<void> {
    if (!this.isAnalyzing) return;

    this.isAnalyzing = false;

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    this.logger.info('AI analysis stopped');
  }

  private async performPeriodicAnalysis(): Promise<void> {
    try {
      // Check if AI usage should be triggered
      const shouldUseAI = await this.shouldUseAI();
      
      if (!shouldUseAI) {
        this.logger.debug('AI analysis skipped - conditions not met');
        return;
      }

      // Analyze current market conditions
      await this.analyzeMarket(Config.TRADING_SYMBOLS);

      this.logger.debug('Periodic AI analysis completed');
    } catch (error) {
      this.logger.error('Error during periodic AI analysis', error);
    }
  }

  private async shouldUseAI(): Promise<boolean> {
    if (!this.config.enabled) return false;

    // Check usage limits
    if (!this.canMakeRequest()) return false;

    // Check market conditions
    const criteria = await this.getDecisionCriteria();
    
    const score = 
      (criteria.marketVolatility > this.config.volatilityThreshold ? 25 : 0) +
      (criteria.strategyConflict ? 30 : 0) +
      (criteria.anomalyDetected ? 35 : 0) +
      (criteria.performanceLag ? 10 : 0);

    return score >= 50;
  }

  private async getDecisionCriteria(): Promise<AIDecisionCriteria> {
    // Calculate average market volatility
    const volatilities = Object.values(this.marketConditions.volatility);
    const avgVolatility = volatilities.length > 0 ? 
      volatilities.reduce((sum, vol) => sum + vol, 0) / volatilities.length : 0;

    // Check for strategy conflicts (would need actual signal data)
    const strategyConflict = false; // Placeholder

    // Check for anomalies
    const anomalyDetected = this.marketConditions.anomalies.length > 0;

    // Check performance lag (would need actual performance data)
    const performanceLag = false; // Placeholder

    return {
      marketVolatility: avgVolatility,
      strategyConflict,
      anomalyDetected,
      performanceLag
    };
  }

  private async analyzeMarket(symbols: string[], customPrompt?: string, forceAnalysis: boolean = false): Promise<AIRecommendation | null> {
    if (!this.config.enabled) {
      throw new Error('AI analysis is disabled');
    }

    if (!forceAnalysis && !this.canMakeRequest()) {
      throw new Error('AI usage limits exceeded');
    }

    try {
      // Gather market data
      const marketData = await this.gatherMarketData(symbols);
      
      // Create analysis prompt
      const prompt = this.createAnalysisPrompt(marketData, customPrompt);
      
      // Get AI recommendation
      const recommendation = await this.getAIRecommendation(prompt);
      
      // Store decision
      await this.storeAIDecision(recommendation, 'MARKET_ANALYSIS', marketData);
      
      // Publish recommendation
      await messageQueue.publishAIDecision(recommendation);

      this.logger.info('AI market analysis completed', {
        symbols: symbols.length,
        confidence: recommendation.confidence,
        action: recommendation.action
      });

      return recommendation;
    } catch (error) {
      this.logger.error('Error during AI market analysis', error);
      throw error;
    }
  }

  private async getTradeRecommendation(signals: Signal[], marketData: any, riskLevel: string): Promise<AIRecommendation | null> {
    if (!this.config.enabled || !this.canMakeRequest()) {
      return null;
    }

    try {
      const prompt = this.createTradeRecommendationPrompt(signals, marketData, riskLevel);
      const recommendation = await this.getAIRecommendation(prompt);
      
      await this.storeAIDecision(recommendation, 'TRADE_RECOMMENDATION', { signals, marketData, riskLevel });

      this.logger.info('AI trade recommendation generated', {
        signals: signals.length,
        confidence: recommendation.confidence,
        action: recommendation.action
      });

      return recommendation;
    } catch (error) {
      this.logger.error('Error getting trade recommendation', error);
      return null;
    }
  }

  private async gatherMarketData(symbols: string[]): Promise<any> {
    const marketData: any = {};

    for (const symbol of symbols) {
      try {
        const data = await redis.getMarketData(symbol);
        if (data) {
          marketData[symbol] = data;
        }
      } catch (error) {
        this.logger.warn(`Failed to get market data for ${symbol}`, error);
      }
    }

    // Add market snapshot
    const snapshot = await redis.get('market:snapshot');
    if (snapshot) {
      marketData.snapshot = snapshot;
    }

    return marketData;
  }

  private createAnalysisPrompt(marketData: any, customPrompt?: string): string {
    const basePrompt = `
You are an expert cryptocurrency futures trader analyzing current market conditions for profitable trading opportunities.

Current Market Data:
${JSON.stringify(marketData, null, 2)}

Market Conditions:
- Average Volatility: ${Object.values(this.marketConditions.volatility).reduce((sum: number, vol: number) => sum + vol, 0) / Object.keys(this.marketConditions.volatility).length || 0}%
- Detected Anomalies: ${this.marketConditions.anomalies.join(', ') || 'None'}
- Market Sentiment: ${this.marketConditions.sentiment}

${customPrompt ? `Additional Context: ${customPrompt}` : ''}

Provide a trading recommendation with:
1. Action: BUY, SELL, HOLD, CLOSE_ALL, or REDUCE_RISK
2. Confidence: 0-100
3. Reasoning: Detailed analysis of market conditions
4. Risk Assessment: Current market risk evaluation
5. Target symbols: Which cryptocurrencies to focus on

Format your response as JSON:
{
  "action": "ACTION",
  "confidence": NUMBER,
  "reasoning": "DETAILED_REASONING",
  "riskAssessment": "RISK_ANALYSIS",
  "targetSymbols": ["SYMBOL1", "SYMBOL2"]
}
`;

    return basePrompt;
  }

  private createTradeRecommendationPrompt(signals: Signal[], marketData: any, riskLevel: string): string {
    return `
You are evaluating trading signals for cryptocurrency futures trading.

Current Signals:
${JSON.stringify(signals, null, 2)}

Market Data:
${JSON.stringify(marketData, null, 2)}

Current Risk Level: ${riskLevel}

Analyze the signals and provide a recommendation considering:
1. Signal quality and confidence
2. Market conditions and volatility
3. Current risk level
4. Potential for profit vs. risk

Provide recommendation as JSON:
{
  "action": "BUY|SELL|HOLD|CLOSE_ALL|REDUCE_RISK",
  "confidence": NUMBER,
  "reasoning": "ANALYSIS",
  "riskAssessment": "RISK_EVALUATION"
}
`;
  }

  private async getAIRecommendation(prompt: string): Promise<AIRecommendation> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject, prompt });
    });
  }

  private async processRequestQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0 && this.canMakeRequest()) {
      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        const response = await this.openai!.chat.completions.create({
          model: Config.OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You are an expert cryptocurrency futures trader and market analyst.'
            },
            {
              role: 'user',
              content: request.prompt
            }
          ],
          max_tokens: Config.OPENAI_MAX_TOKENS,
          temperature: 0.3
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error('No response content from OpenAI');
        }

        // Parse JSON response
        const parsed = JSON.parse(content);
        
        const recommendation: AIRecommendation = {
          action: parsed.action || 'HOLD',
          confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
          reasoning: parsed.reasoning || 'AI analysis completed',
          marketAnalysis: parsed.riskAssessment || 'Market analysis performed',
          riskAssessment: parsed.riskAssessment || 'Risk assessment completed',
          timestamp: Date.now()
        };

        // Update usage stats
        this.updateUsageStats(response);

        request.resolve(recommendation);

        // Add delay between requests
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        this.logger.error('Error processing AI request', error);
        request.reject(error);
      }
    }

    this.isProcessingQueue = false;

    // Continue processing if there are more requests
    if (this.requestQueue.length > 0) {
      setTimeout(() => this.processRequestQueue(), 5000);
    }
  }

  private canMakeRequest(): boolean {
    const now = new Date();
    
    // Reset hourly counters if needed
    if (now.getTime() - this.usageStats.lastReset.getTime() > 3600000) {
      this.usageStats.hourlyRequests = 0;
      this.usageStats.hourlyCost = 0;
      this.usageStats.lastReset = now;
    }

    // Check hourly limits
    if (this.usageStats.hourlyRequests >= this.config.maxRequestsPerHour) {
      return false;
    }

    // Check cost limits
    if (this.usageStats.hourlyCost >= this.config.usageCostLimit) {
      return false;
    }

    // Check cooldown period
    if (now.getTime() - this.usageStats.lastRequest.getTime() < this.config.cooldownPeriod) {
      return false;
    }

    return true;
  }

  private updateUsageStats(response: any): void {
    const cost = this.calculateRequestCost(response);
    
    this.usageStats.hourlyRequests++;
    this.usageStats.hourlyCost += cost;
    this.usageStats.totalRequests++;
    this.usageStats.totalCost += cost;
    this.usageStats.lastRequest = new Date();
  }

  private calculateRequestCost(response: any): number {
    // Estimate cost based on token usage
    const inputTokens = response.usage?.prompt_tokens || 1000;
    const outputTokens = response.usage?.completion_tokens || 500;
    
    // GPT-4 pricing (approximate)
    const inputCost = (inputTokens / 1000) * 0.03;
    const outputCost = (outputTokens / 1000) * 0.06;
    
    return inputCost + outputCost;
  }

  // Market Condition Updates
  private async updateMarketConditions(payload: any): Promise<void> {
    const { symbol, data } = payload;
    
    if (data.price && data.priceChange24h) {
      // Update volatility
      this.marketConditions.volatility[symbol] = Math.abs(data.priceChange24h);
      
      // Update trend
      if (data.priceChange24h > 2) {
        this.marketConditions.trends[symbol] = 'BULLISH';
      } else if (data.priceChange24h < -2) {
        this.marketConditions.trends[symbol] = 'BEARISH';
      } else {
        this.marketConditions.trends[symbol] = 'SIDEWAYS';
      }

      // Detect anomalies
      await this.detectAnomalies(symbol, data);
    }
  }

  private async detectAnomalies(symbol: string, data: any): Promise<void> {
    const volatility = Math.abs(data.priceChange24h);
    
    // High volatility anomaly
    if (volatility > 15) {
      const anomaly = `High volatility detected for ${symbol}: ${volatility.toFixed(2)}%`;
      if (!this.marketConditions.anomalies.includes(anomaly)) {
        this.marketConditions.anomalies.push(anomaly);
        this.logger.warn('Market anomaly detected', { symbol, volatility });
      }
    }

    // Volume anomaly
    if (data.volume24h && data.volume24h > 0) {
      // Placeholder for volume anomaly detection
    }

    // Keep only recent anomalies
    this.marketConditions.anomalies = this.marketConditions.anomalies.slice(-10);
  }

  private async evaluateSignal(signal: Signal): Promise<void> {
    if (!this.config.enabled) return;

    // Only analyze signals with moderate confidence
    if (signal.confidence < 60) return;

    try {
      const marketData = await redis.getMarketData(signal.symbol);
      if (!marketData) return;

      const recommendation = await this.getTradeRecommendation(
        [signal],
        { [signal.symbol]: marketData },
        'MEDIUM' // Default risk level
      );

      if (recommendation && recommendation.confidence > this.config.confidenceThreshold) {
        this.logger.info('AI enhanced signal recommendation', {
          originalSignal: signal.action,
          aiRecommendation: recommendation.action,
          confidence: recommendation.confidence
        });

        // Publish enhanced recommendation
        await messageQueue.publishAIDecision(recommendation);
      }
    } catch (error) {
      this.logger.error('Error evaluating signal with AI', error);
    }
  }

  private async evaluateRiskConditions(payload: any): Promise<void> {
    if (!this.config.enabled) return;

    const { riskLevel, data } = payload;
    
    if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      try {
        const recommendation = await this.analyzeMarket(
          Config.TRADING_SYMBOLS.slice(0, 3), // Analyze top 3 symbols
          `Current risk level is ${riskLevel}. Should we reduce risk or close positions?`,
          true
        );

        if (recommendation && recommendation.action === 'REDUCE_RISK' || recommendation.action === 'CLOSE_ALL') {
          this.logger.warn('AI recommends risk reduction', {
            riskLevel,
            recommendation: recommendation.action,
            confidence: recommendation.confidence
          });
        }
      } catch (error) {
        this.logger.error('Error evaluating risk conditions', error);
      }
    }
  }

  // Data Persistence
  private async storeAIDecision(recommendation: AIRecommendation, triggerReason: string, marketConditions: any): Promise<void> {
    try {
      await db.query(
        `INSERT INTO ai_decisions (
          timestamp, trigger_reason, market_analysis, recommendation,
          confidence, reasoning, market_conditions, cost_estimate
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          new Date(),
          triggerReason,
          recommendation.marketAnalysis,
          recommendation.action,
          recommendation.confidence,
          recommendation.reasoning,
          JSON.stringify(marketConditions),
          0.05 // Estimated cost
        ]
      );
    } catch (error) {
      this.logger.error('Error storing AI decision', error);
    }
  }

  private async loadUsageStats(): Promise<void> {
    try {
      const cached = await redis.get('ai:usage_stats');
      if (cached) {
        this.usageStats = { ...this.usageStats, ...cached };
      }
    } catch (error) {
      this.logger.warn('Could not load usage stats', error);
    }
  }

  private async saveUsageStats(): Promise<void> {
    try {
      await redis.set('ai:usage_stats', this.usageStats);
    } catch (error) {
      this.logger.error('Error saving usage stats', error);
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await redis.set('ai:config', this.config);
    } catch (error) {
      this.logger.error('Error saving AI config', error);
    }
  }

  private async emergencyStop(): Promise<void> {
    await this.stopAIAnalysis();
    this.requestQueue = [];
    this.logger.warn('AI Advisor emergency stop completed');
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      isAnalyzing: this.isAnalyzing,
      enabled: this.config.enabled,
      queueSize: this.requestQueue.length,
      hourlyRequests: this.usageStats.hourlyRequests,
      hourlyCost: this.usageStats.hourlyCost,
      totalRequests: this.usageStats.totalRequests,
      anomalies: this.marketConditions.anomalies.length
    };
  }
}

export default AIAdvisorService;