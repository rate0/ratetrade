// Core trading types and interfaces

export interface MarketData {
  symbol: string;
  price: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  priceChange24h: number;
  fundingRate: number;
  timestamp: number;
  openInterest?: number;
  markPrice?: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastUpdateId: number;
  timestamp: number;
}

export interface Position {
  id?: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginUsed: number;
  liquidationPrice?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Trade {
  id?: number;
  timestamp: Date;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  fee: number;
  realizedPnl?: number;
  strategyId: string;
  mode: 'LIVE' | 'SIM';
  binanceOrderId?: number;
  createdAt?: Date;
}

export interface Signal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'CLOSE';
  confidence: number; // 0-100
  targetPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  reasoning: string;
  strategy: string;
  timestamp: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  executedQty: number;
  averagePrice?: number;
  createdAt: Date;
  updatedAt: Date;
  binanceOrderId?: number;
}

export interface RiskMetrics {
  totalBalance: number;
  availableBalance: number;
  totalUnrealizedPnl: number;
  dailyPnl: number;
  maxDrawdown: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  isTradeAllowed: boolean;
  marginUsage: number;
  liquidationRisk: number;
}

export interface PositionSize {
  size: number;
  leverage: number;
  stopLoss: number;
  margin: number;
}

export interface BacktestResult {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
}

export interface PerformanceMetrics {
  totalReturn: number;
  dailyReturn: number;
  weeklyReturn: number;
  monthlyReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  totalTrades: number;
}

export interface AIDecisionCriteria {
  marketVolatility: number;
  strategyConflict: boolean;
  anomalyDetected: boolean;
  performanceLag: boolean;
}

export interface AIRecommendation {
  action: 'BUY' | 'SELL' | 'HOLD' | 'CLOSE_ALL' | 'REDUCE_RISK';
  confidence: number;
  reasoning: string;
  marketAnalysis: string;
  riskAssessment: string;
  timestamp: number;
}

export interface ServiceConfig {
  name: string;
  port: number;
  host: string;
  healthPath: string;
  dependencies: string[];
}

export interface TradingConfig {
  mode: 'LIVE' | 'SIM';
  maxDailyLossPercent: number;
  defaultLeverage: number;
  maxLeverage: number;
  maxPositionPercent: number;
  riskFreeRate: number;
  symbols: string[];
  strategies: string[];
}

export interface NotificationConfig {
  telegram: {
    token: string;
    whitelistIds: number[];
    chatId?: number;
  };
  alerts: {
    trades: boolean;
    positions: boolean;
    risk: boolean;
    ai: boolean;
    errors: boolean;
  };
}

// Service Messages
export interface ServiceMessage {
  type: string;
  payload: any;
  timestamp: number;
  source: string;
  correlationId?: string;
}

export interface HealthStatus {
  service: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'DEGRADED';
  uptime: number;
  lastCheck: Date;
  dependencies: Record<string, boolean>;
  metrics?: Record<string, any>;
}

// Telegram Types
export interface TelegramKeyboard {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data: string;
  }>>;
}

export interface TelegramNotification {
  type: 'trade' | 'position' | 'risk' | 'ai' | 'error' | 'digest';
  title: string;
  message: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  keyboard?: TelegramKeyboard;
  timestamp: number;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface SignalResponse {
  timestamp: number;
  signals: Signal[];
  marketConditions: {
    volatility: number;
    trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    sentiment: number;
  };
}

export interface RiskResponse {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  metrics: RiskMetrics;
  limits: {
    dailyLossLimit: number;
    maxLeverage: number;
    maxPositionSize: number;
  };
  recommendations: string[];
}

// Error Types
export class TradingError extends Error {
  constructor(
    message: string,
    public code: string,
    public severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM'
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export class APIError extends TradingError {
  constructor(message: string, public statusCode: number) {
    super(message, 'API_ERROR', 'HIGH');
    this.name = 'APIError';
  }
}

export class RiskError extends TradingError {
  constructor(message: string) {
    super(message, 'RISK_ERROR', 'CRITICAL');
    this.name = 'RiskError';
  }
}

export class ValidationError extends TradingError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 'MEDIUM');
    this.name = 'ValidationError';
  }
}