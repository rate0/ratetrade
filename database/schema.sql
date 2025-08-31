-- Trading Bot Database Schema

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Trades table
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity DECIMAL(18,8) NOT NULL,
    price DECIMAL(18,8) NOT NULL,
    fee DECIMAL(18,8) NOT NULL DEFAULT 0,
    realized_pnl DECIMAL(18,8),
    strategy_id VARCHAR(50),
    mode VARCHAR(4) NOT NULL CHECK (mode IN ('LIVE', 'SIM')),
    binance_order_id BIGINT,
    correlation_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT trades_quantity_positive CHECK (quantity > 0),
    CONSTRAINT trades_price_positive CHECK (price > 0)
);

-- Create indexes for trades
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(5) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    size DECIMAL(18,8) NOT NULL,
    entry_price DECIMAL(18,8) NOT NULL,
    mark_price DECIMAL(18,8),
    unrealized_pnl DECIMAL(18,8),
    leverage INTEGER NOT NULL CHECK (leverage > 0 AND leverage <= 125),
    margin DECIMAL(18,8) NOT NULL,
    liquidation_price DECIMAL(18,8),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT positions_size_positive CHECK (size > 0),
    CONSTRAINT positions_entry_price_positive CHECK (entry_price > 0),
    CONSTRAINT positions_margin_positive CHECK (margin > 0),
    UNIQUE(symbol, side)
);

-- Create indexes for positions
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_updated ON positions(updated_at DESC);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    type VARCHAR(20) NOT NULL CHECK (type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET')),
    quantity DECIMAL(18,8) NOT NULL,
    price DECIMAL(18,8),
    stop_price DECIMAL(18,8),
    time_in_force VARCHAR(3) CHECK (time_in_force IN ('GTC', 'IOC', 'FOK')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
    executed_qty DECIMAL(18,8) DEFAULT 0,
    average_price DECIMAL(18,8),
    binance_order_id BIGINT,
    strategy_id VARCHAR(50),
    mode VARCHAR(4) NOT NULL CHECK (mode IN ('LIVE', 'SIM')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
    CONSTRAINT orders_price_positive CHECK (price IS NULL OR price > 0),
    CONSTRAINT orders_executed_qty_valid CHECK (executed_qty >= 0 AND executed_qty <= quantity)
);

-- Create indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_binance_id ON orders(binance_order_id);

-- Risk metrics table
CREATE TABLE IF NOT EXISTS risk_metrics (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    total_balance DECIMAL(18,8) NOT NULL,
    available_balance DECIMAL(18,8) NOT NULL,
    total_unrealized_pnl DECIMAL(18,8) DEFAULT 0,
    daily_pnl DECIMAL(18,8) DEFAULT 0,
    max_drawdown DECIMAL(18,8) DEFAULT 0,
    risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_level VARCHAR(10) CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    margin_usage DECIMAL(5,2) DEFAULT 0 CHECK (margin_usage >= 0 AND margin_usage <= 100),
    liquidation_risk DECIMAL(5,2) DEFAULT 0 CHECK (liquidation_risk >= 0 AND liquidation_risk <= 100),
    mode VARCHAR(4) NOT NULL CHECK (mode IN ('LIVE', 'SIM')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT risk_metrics_balance_positive CHECK (total_balance >= 0),
    CONSTRAINT risk_metrics_available_valid CHECK (available_balance >= 0)
);

-- Create indexes for risk metrics
CREATE INDEX IF NOT EXISTS idx_risk_metrics_timestamp ON risk_metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_mode ON risk_metrics(mode);

-- Strategy performance table
CREATE TABLE IF NOT EXISTS strategy_performance (
    id SERIAL PRIMARY KEY,
    strategy_id VARCHAR(50) NOT NULL,
    symbol VARCHAR(20),
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    total_return DECIMAL(10,4) DEFAULT 0,
    daily_return DECIMAL(10,4) DEFAULT 0,
    weekly_return DECIMAL(10,4) DEFAULT 0,
    monthly_return DECIMAL(10,4) DEFAULT 0,
    sharpe_ratio DECIMAL(8,4),
    max_drawdown DECIMAL(8,4) DEFAULT 0,
    win_rate DECIMAL(5,2) DEFAULT 0,
    profit_factor DECIMAL(8,4),
    average_win DECIMAL(18,8) DEFAULT 0,
    average_loss DECIMAL(18,8) DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(strategy_id, symbol)
);

-- Create indexes for strategy performance
CREATE INDEX IF NOT EXISTS idx_strategy_perf_strategy ON strategy_performance(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_perf_updated ON strategy_performance(last_updated DESC);

-- AI decisions table
CREATE TABLE IF NOT EXISTS ai_decisions (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    trigger_reason VARCHAR(100) NOT NULL,
    market_analysis TEXT,
    recommendation VARCHAR(20) NOT NULL,
    confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
    reasoning TEXT,
    market_conditions JSONB,
    cost_estimate DECIMAL(8,4),
    outcome VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for AI decisions
CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp ON ai_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_recommendation ON ai_decisions(recommendation);

-- Market data snapshots table (for backtesting and analysis)
CREATE TABLE IF NOT EXISTS market_snapshots (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    price DECIMAL(18,8) NOT NULL,
    bid_price DECIMAL(18,8),
    ask_price DECIMAL(18,8),
    volume_24h DECIMAL(18,8),
    price_change_24h DECIMAL(8,4),
    funding_rate DECIMAL(8,6),
    open_interest DECIMAL(18,8),
    mark_price DECIMAL(18,8),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT market_snapshots_price_positive CHECK (price > 0)
);

-- Create indexes for market snapshots
CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_time ON market_snapshots(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_timestamp ON market_snapshots(timestamp DESC);

-- Notifications log table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    priority VARCHAR(10) CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    telegram_message_id INTEGER,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- System configuration table
CREATE TABLE IF NOT EXISTS system_config (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default configuration
INSERT INTO system_config (key, value, description) VALUES
('trading_enabled', 'true', 'Global trading enable/disable flag'),
('risk_level', 'MEDIUM', 'Current system risk level'),
('daily_loss_limit', '5.0', 'Daily loss limit percentage'),
('max_leverage', '10', 'Maximum allowed leverage'),
('max_position_size', '30.0', 'Maximum position size percentage of balance')
ON CONFLICT (key) DO NOTHING;

-- Functions and triggers

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_strategy_performance_updated_at BEFORE UPDATE ON strategy_performance
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_system_config_updated_at BEFORE UPDATE ON system_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to calculate daily PnL
CREATE OR REPLACE FUNCTION calculate_daily_pnl(p_date DATE DEFAULT CURRENT_DATE)
RETURNS DECIMAL(18,8) AS $$
DECLARE
    daily_pnl DECIMAL(18,8) := 0;
BEGIN
    SELECT COALESCE(SUM(realized_pnl), 0)
    INTO daily_pnl
    FROM trades
    WHERE DATE(timestamp AT TIME ZONE 'UTC+5') = p_date
    AND realized_pnl IS NOT NULL;
    
    RETURN daily_pnl;
END;
$$ LANGUAGE plpgsql;

-- Function to get current positions summary
CREATE OR REPLACE FUNCTION get_positions_summary()
RETURNS TABLE(
    total_positions INTEGER,
    total_unrealized_pnl DECIMAL(18,8),
    total_margin_used DECIMAL(18,8),
    highest_leverage INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::INTEGER as total_positions,
        COALESCE(SUM(unrealized_pnl), 0) as total_unrealized_pnl,
        COALESCE(SUM(margin), 0) as total_margin_used,
        COALESCE(MAX(leverage), 0)::INTEGER as highest_leverage
    FROM positions
    WHERE size > 0;
END;
$$ LANGUAGE plpgsql;

-- View for trading performance summary
CREATE OR REPLACE VIEW trading_performance AS
SELECT 
    mode,
    COUNT(*) as total_trades,
    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
    ROUND(
        (SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::DECIMAL / 
         NULLIF(COUNT(*), 0) * 100), 2
    ) as win_rate,
    COALESCE(SUM(realized_pnl), 0) as total_pnl,
    COALESCE(AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END), 0) as avg_win,
    COALESCE(AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END), 0) as avg_loss,
    DATE(timestamp AT TIME ZONE 'UTC+5') as trade_date
FROM trades
WHERE realized_pnl IS NOT NULL
GROUP BY mode, DATE(timestamp AT TIME ZONE 'UTC+5')
ORDER BY trade_date DESC;