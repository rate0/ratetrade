import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { RiskMetrics, Position, Signal, PositionSize, ServiceMessage, RiskError } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import { binanceAPI } from '@/utils/binance';
import Joi from 'joi';

interface RiskLimits {
  dailyLossLimit: number;
  maxLeverage: number;
  maxPositionSize: number;
  maxDrawdown: number;
  maxOpenPositions: number;
  concentrationLimit: number;
  liquidationBuffer: number;
}

interface RiskAssessment {
  symbol: string;
  isAllowed: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons: string[];
  recommendedSize: number;
  recommendedLeverage: number;
  maxAllowedSize: number;
  stopLoss: number;
}

export class RiskEngineService extends BaseService {
  private riskLimits: RiskLimits;
  private currentRiskMetrics: RiskMetrics | null = null;
  private positions: Map<string, Position> = new Map();
  private dailyPnL: number = 0;
  private maxDrawdown: number = 0;
  private balanceHistory: number[] = [];
  private isMonitoring: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor() {
    super('risk-engine');
    this.riskLimits = {
      dailyLossLimit: Config.MAX_DAILY_LOSS_PERCENT,
      maxLeverage: Config.MAX_LEVERAGE,
      maxPositionSize: Config.MAX_POSITION_PERCENT,
      maxDrawdown: 15,
      maxOpenPositions: 5,
      concentrationLimit: 40,
      liquidationBuffer: 20
    };
    this.setupRoutes();
  }

  protected async initialize(): Promise<void> {
    await messageQueue.subscribe('risk.assessment', this.handleCommand.bind(this));
    await this.loadRiskConfiguration();
    await this.loadCurrentPositions();
    await this.startRiskMonitoring();
    this.logger.info('Risk Engine Service initialized');
  }

  protected async cleanup(): Promise<void> {
    await this.stopRiskMonitoring();
    this.logger.info('Risk Engine Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();
    app.get('/api/risk/current', this.asyncHandler(this.getCurrentRiskHandler.bind(this)));
    app.get('/api/risk/limits', this.asyncHandler(this.getRiskLimitsHandler.bind(this)));
    app.put('/api/risk/limits', this.asyncHandler(this.updateRiskLimitsHandler.bind(this)));
    app.post('/api/risk/validate-position', this.asyncHandler(this.validatePositionHandler.bind(this)));
    app.post('/api/risk/calculate-size', this.asyncHandler(this.calculatePositionSizeHandler.bind(this)));
    app.post('/api/risk/emergency-stop', this.asyncHandler(this.emergencyStopHandler.bind(this)));
  }

  private async getCurrentRiskHandler(req: Request, res: Response): Promise<void> {
    await this.updateRiskMetrics();
    this.sendResponse(res, true, this.currentRiskMetrics);
  }

  private async getRiskLimitsHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.riskLimits);
  }

  private async updateRiskLimitsHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      dailyLossLimit: Joi.number().min(0).max(50),
      maxLeverage: Joi.number().min(1).max(125),
      maxPositionSize: Joi.number().min(0).max(100),
      maxDrawdown: Joi.number().min(0).max(50)
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      await this.updateRiskLimits(req.body);
      this.sendResponse(res, true, this.riskLimits);
    } catch (error) {
      this.logger.error('Error updating risk limits', error);
      this.sendResponse(res, false, null, 'Failed to update risk limits');
    }
  }

  private async validatePositionHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      symbol: Joi.string().required(),
      side: Joi.string().valid('LONG', 'SHORT').required(),
      size: Joi.number().positive().required(),
      leverage: Joi.number().min(1).max(125).required(),
      price: Joi.number().positive().required()
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const assessment = await this.validatePosition(req.body);
      this.sendResponse(res, true, assessment);
    } catch (error) {
      this.logger.error('Error validating position', error);
      this.sendResponse(res, false, null, 'Failed to validate position');
    }
  }

  private async calculatePositionSizeHandler(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      signal: Joi.object({
        symbol: Joi.string().required(),
        action: Joi.string().valid('BUY', 'SELL').required(),
        confidence: Joi.number().min(0).max(100).required(),
        stopLoss: Joi.number().positive()
      }).required(),
      currentPrice: Joi.number().positive().required()
    });

    const validation = this.validateRequest(schema, req.body);
    if (!validation.isValid) {
      this.sendResponse(res, false, null, validation.errors?.join(', '));
      return;
    }

    try {
      const positionSize = await this.calculateOptimalPositionSize(req.body.signal, req.body.currentPrice);
      this.sendResponse(res, true, positionSize);
    } catch (error) {
      this.logger.error('Error calculating position size', error);
      this.sendResponse(res, false, null, 'Failed to calculate position size');
    }
  }

  private async emergencyStopHandler(req: Request, res: Response): Promise<void> {
    try {
      await this.executeEmergencyStop();
      this.sendResponse(res, true, { message: 'Emergency stop executed' });
    } catch (error) {
      this.logger.error('Error executing emergency stop', error);
      this.sendResponse(res, false, null, 'Failed to execute emergency stop');
    }
  }

  private async handleCommand(message: ServiceMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'START_TRADING':
          await this.startRiskMonitoring();
          break;
        case 'STOP_TRADING':
          await this.stopRiskMonitoring();
          break;
        case 'EMERGENCY_STOP':
          await this.executeEmergencyStop();
          break;
        default:
          this.logger.warn('Unknown command received', { type: message.type });
      }
    } catch (error) {
      this.logger.error('Error handling command', error, { command: message.type });
    }
  }

  private async loadRiskConfiguration(): Promise<void> {
    try {
      const cached = await redis.getRiskMetrics<RiskMetrics>();
      if (cached) {
        this.currentRiskMetrics = cached;
      }
      this.logger.info('Risk configuration loaded');
    } catch (error) {
      this.logger.error('Error loading risk configuration', error);
    }
  }

  private async updateRiskLimits(updates: Partial<RiskLimits>): Promise<void> {
    this.riskLimits = { ...this.riskLimits, ...updates };
    
    for (const [key, value] of Object.entries(updates)) {
      await db.query(
        `INSERT INTO system_config (key, value, description) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [`risk_${key}`, value.toString(), `Risk limit: ${key}`]
      );
    }

    this.logger.info('Risk limits updated', updates);
    await messageQueue.publishRiskUpdate({
      type: 'RISK_LIMITS_UPDATED',
      limits: this.riskLimits
    });
  }

  private async startRiskMonitoring(): Promise<void> {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(async () => {
      await this.performRiskAssessment();
    }, 30000);

    this.logger.info('Risk monitoring started');
  }

  private async stopRiskMonitoring(): Promise<void> {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    this.logger.info('Risk monitoring stopped');
  }

  private async performRiskAssessment(): Promise<void> {
    try {
      await this.updateRiskMetrics();
      await this.checkRiskLimits();
      
      this.logger.debug('Risk assessment completed', {
        riskLevel: this.currentRiskMetrics?.riskLevel,
        dailyPnL: this.dailyPnL
      });
    } catch (error) {
      this.logger.error('Error during risk assessment', error);
    }
  }

  private async updateRiskMetrics(): Promise<void> {
    try {
      const balance = await binanceAPI.getFuturesBalance();
      const totalBalance = balance.total || 0;
      const availableBalance = balance.free || 0;

      const positions = await this.loadCurrentPositions();
      const totalUnrealizedPnl = Array.from(positions.values())
        .reduce((sum, pos) => sum + pos.unrealizedPnl, 0);

      await this.calculateDailyPnL();
      this.updateBalanceHistory(totalBalance + totalUnrealizedPnl);
      this.calculateMaxDrawdown();

      const totalMarginUsed = Array.from(positions.values())
        .reduce((sum, pos) => sum + pos.marginUsed, 0);
      const marginUsage = totalBalance > 0 ? (totalMarginUsed / totalBalance) * 100 : 0;

      const riskLevel = this.determineRiskLevel(totalBalance, totalUnrealizedPnl, marginUsage);

      this.currentRiskMetrics = {
        totalBalance,
        availableBalance,
        totalUnrealizedPnl,
        dailyPnL: this.dailyPnL,
        maxDrawdown: this.maxDrawdown,
        riskLevel,
        isTradeAllowed: riskLevel !== 'CRITICAL',
        marginUsage,
        liquidationRisk: await this.calculateLiquidationRisk()
      };

      await redis.cacheRiskMetrics(this.currentRiskMetrics, 60);
      await this.storeRiskMetrics();

    } catch (error) {
      this.logger.error('Error updating risk metrics', error);
    }
  }

  private async loadCurrentPositions(): Promise<Map<string, Position>> {
    try {
      const binancePositions = await binanceAPI.getFuturesPositions();
      
      this.positions.clear();
      for (const position of binancePositions) {
        this.positions.set(position.symbol, position);
      }

      for (const [symbol, position] of this.positions) {
        await redis.cachePosition(symbol, position);
      }

      return this.positions;
    } catch (error) {
      this.logger.error('Error loading current positions', error);
      return this.positions;
    }
  }

  private async calculateDailyPnL(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await db.query(
        'SELECT calculate_daily_pnl($1) as daily_pnl',
        [today]
      );
      
      this.dailyPnL = parseFloat(result[0]?.daily_pnl || '0');
    } catch (error) {
      this.logger.error('Error calculating daily PnL', error);
      this.dailyPnL = 0;
    }
  }

  private updateBalanceHistory(currentBalance: number): void {
    this.balanceHistory.push(currentBalance);
    if (this.balanceHistory.length > 100) {
      this.balanceHistory.shift();
    }
  }

  private calculateMaxDrawdown(): void {
    if (this.balanceHistory.length < 2) {
      this.maxDrawdown = 0;
      return;
    }

    let peak = this.balanceHistory[0];
    let maxDD = 0;

    for (const balance of this.balanceHistory) {
      if (balance > peak) peak = balance;
      const drawdown = (peak - balance) / peak * 100;
      if (drawdown > maxDD) maxDD = drawdown;
    }

    this.maxDrawdown = maxDD;
  }

  private determineRiskLevel(
    totalBalance: number, 
    unrealizedPnl: number, 
    marginUsage: number
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const dailyLossPercent = Math.abs(this.dailyPnL / totalBalance) * 100;
    
    if (dailyLossPercent > this.riskLimits.dailyLossLimit * 0.8 || marginUsage > 80) {
      return 'CRITICAL';
    }
    if (dailyLossPercent > this.riskLimits.dailyLossLimit * 0.6 || marginUsage > 60) {
      return 'HIGH';
    }
    if (dailyLossPercent > this.riskLimits.dailyLossLimit * 0.3 || marginUsage > 40) {
      return 'MEDIUM';
    }
    
    return 'LOW';
  }

  private async calculateLiquidationRisk(): Promise<number> {
    try {
      let totalLiquidationRisk = 0;
      let totalPositionValue = 0;

      for (const position of this.positions.values()) {
        if (position.liquidationPrice && position.markPrice) {
          const distanceToLiquidation = Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice;
          const positionValue = position.size * position.markPrice;
          
          totalLiquidationRisk += (1 - distanceToLiquidation) * positionValue;
          totalPositionValue += positionValue;
        }
      }

      return totalPositionValue > 0 ? (totalLiquidationRisk / totalPositionValue) * 100 : 0;
    } catch (error) {
      this.logger.error('Error calculating liquidation risk', error);
      return 0;
    }
  }

  private async validatePosition(positionData: any): Promise<RiskAssessment> {
    const { symbol, side, size, leverage, price } = positionData;
    
    const assessment: RiskAssessment = {
      symbol,
      isAllowed: true,
      riskLevel: 'LOW',
      reasons: [],
      recommendedSize: size,
      recommendedLeverage: leverage,
      maxAllowedSize: size,
      stopLoss: 0
    };

    if (!this.currentRiskMetrics?.isTradeAllowed) {
      assessment.isAllowed = false;
      assessment.reasons.push('Trading not allowed due to high risk level');
      assessment.riskLevel = 'CRITICAL';
      return assessment;
    }

    if (leverage > this.riskLimits.maxLeverage) {
      assessment.isAllowed = false;
      assessment.reasons.push(`Leverage ${leverage}x exceeds maximum ${this.riskLimits.maxLeverage}x`);
      assessment.recommendedLeverage = this.riskLimits.maxLeverage;
    }

    const positionValue = size * price;
    const totalBalance = this.currentRiskMetrics?.totalBalance || 0;
    const positionPercent = (positionValue / totalBalance) * 100;

    if (positionPercent > this.riskLimits.maxPositionSize) {
      assessment.isAllowed = false;
      assessment.reasons.push(`Position size ${positionPercent.toFixed(2)}% exceeds maximum ${this.riskLimits.maxPositionSize}%`);
      assessment.maxAllowedSize = (totalBalance * this.riskLimits.maxPositionSize / 100) / price;
      assessment.recommendedSize = assessment.maxAllowedSize;
    }

    const riskAmount = totalBalance * 0.02;
    const stopLossDistance = riskAmount / size;
    assessment.stopLoss = side === 'LONG' ? price - stopLossDistance : price + stopLossDistance;

    return assessment;
  }

  private async calculateOptimalPositionSize(signal: Signal, currentPrice: number): Promise<PositionSize> {
    if (!this.currentRiskMetrics) {
      throw new RiskError('Risk metrics not available');
    }

    const maxRiskPerTrade = 0.02;
    const confidenceMultiplier = signal.confidence / 100;
    const totalBalance = this.currentRiskMetrics.totalBalance;
    
    let baseSize = (totalBalance * maxRiskPerTrade * confidenceMultiplier) / currentPrice;
    
    const maxPositionValue = totalBalance * (this.riskLimits.maxPositionSize / 100);
    const maxSize = maxPositionValue / currentPrice;
    
    if (baseSize > maxSize) {
      baseSize = maxSize;
    }

    const leverage = Math.min(
      Math.ceil(Config.DEFAULT_LEVERAGE * (1 + (signal.confidence - 50) / 100)),
      this.riskLimits.maxLeverage
    );

    const stopLossDistance = signal.stopLoss ? Math.abs(currentPrice - signal.stopLoss) : currentPrice * 0.02;
    const stopLoss = signal.action === 'BUY' ? 
      currentPrice - stopLossDistance : 
      currentPrice + stopLossDistance;

    const margin = (baseSize * currentPrice) / leverage;

    return {
      size: baseSize,
      leverage,
      stopLoss,
      margin
    };
  }

  private async checkRiskLimits(): Promise<void> {
    if (!this.currentRiskMetrics) return;

    const dailyLossPercent = Math.abs(this.dailyPnL / this.currentRiskMetrics.totalBalance) * 100;
    
    if (dailyLossPercent > this.riskLimits.dailyLossLimit) {
      await this.triggerRiskAlert('DAILY_LOSS_LIMIT_EXCEEDED', { dailyLoss: dailyLossPercent });
    }

    if (this.maxDrawdown > this.riskLimits.maxDrawdown) {
      await this.triggerRiskAlert('MAX_DRAWDOWN_EXCEEDED', { drawdown: this.maxDrawdown });
    }

    if (this.currentRiskMetrics.marginUsage > 80) {
      await this.triggerRiskAlert('HIGH_MARGIN_USAGE', { marginUsage: this.currentRiskMetrics.marginUsage });
    }
  }

  private async triggerRiskAlert(alertType: string, data: any): Promise<void> {
    await messageQueue.publishRiskUpdate({
      type: alertType,
      data,
      riskLevel: this.currentRiskMetrics?.riskLevel,
      timestamp: Date.now()
    });

    await db.query(
      `INSERT INTO notifications (type, title, message, priority, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['risk', alertType, JSON.stringify(data), 'HIGH']
    );
  }

  private async storeRiskMetrics(): Promise<void> {
    if (!this.currentRiskMetrics) return;

    await db.query(
      `INSERT INTO risk_metrics (
        timestamp, total_balance, available_balance, total_unrealized_pnl,
        daily_pnl, max_drawdown, risk_level, margin_usage, liquidation_risk, mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        new Date(),
        this.currentRiskMetrics.totalBalance,
        this.currentRiskMetrics.availableBalance,
        this.currentRiskMetrics.totalUnrealizedPnl,
        this.currentRiskMetrics.dailyPnL,
        this.currentRiskMetrics.maxDrawdown,
        this.currentRiskMetrics.riskLevel,
        this.currentRiskMetrics.marginUsage,
        this.currentRiskMetrics.liquidationRisk,
        Config.BOT_MODE
      ]
    );
  }

  private calculateSymbolExposure(symbol: string): number {
    const position = this.positions.get(symbol);
    return position ? position.size * position.markPrice : 0;
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const marketData = await redis.getMarketData(symbol);
    return marketData?.price || 0;
  }

  private async executeEmergencyStop(): Promise<void> {
    this.logger.warn('Emergency stop initiated');
    
    await this.stopRiskMonitoring();
    
    await messageQueue.publishRiskUpdate({
      type: 'EMERGENCY_STOP',
      riskLevel: 'CRITICAL',
      timestamp: Date.now()
    });

    this.logger.warn('Emergency stop completed');
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      isMonitoring: this.isMonitoring,
      openPositions: this.positions.size,
      dailyPnL: this.dailyPnL,
      maxDrawdown: this.maxDrawdown,
      riskLevel: this.currentRiskMetrics?.riskLevel
    };
  }
}

export default RiskEngineService;