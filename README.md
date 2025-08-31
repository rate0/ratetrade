# Crypto Trading Bot - Production System

A fully production-ready autonomous crypto trading bot for **Binance Futures (USDⓈ-M)** with microservices architecture, Telegram control interface, and selective OpenAI integration.

## 🚀 Features

- **Autonomous Trading**: Maximally efficient and "greedy" for profit while maintaining strict risk controls
- **Dual Mode Operation**: LIVE (real trading) and SIM (simulation with real market data)
- **Telegram Control**: Complete bot management via Telegram with inline keyboards
- **AI Enhancement**: Selective OpenAI integration for strategy optimization and market analysis
- **Microservices Architecture**: Scalable, maintainable system with clear service boundaries
- **Risk Management**: Comprehensive leverage control, position sizing, and emergency stops
- **Real-time Monitoring**: Health checks, metrics, and performance tracking

## 🏗️ Architecture

The system consists of 9 core microservices:

1. **Orchestrator** - Central coordinator and decision maker
2. **Market Data Service** - Real-time market data provider
3. **Strategy Engine** - Trading signal generation with multiple strategies
4. **Risk Engine** - Risk assessment and position sizing
5. **Execution Service** - Order management and execution
6. **AI Advisor** - Selective OpenAI integration for enhanced decisions
7. **Telegram Notifier** - Bot control and notifications
8. **Storage Service** - Data persistence and reporting
9. **Watchdog Service** - Health monitoring and recovery

## 🛠️ Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for development)
- Binance Futures account with API keys
- Telegram Bot Token
- OpenAI API key (optional)

## 📦 Quick Start

### 1. Clone and Setup

```bash
git clone <repository-url>
cd ratetrade
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` file with your credentials:

```env
# Required: Binance API Credentials
BINANCE_KEY=your_binance_api_key_here
BINANCE_SECRET=your_binance_api_secret_here

# Required: Telegram Configuration
TELEGRAM_TOKEN=your_telegram_bot_token_here
TELEGRAM_WHITELIST_IDS=your_telegram_user_id_here

# Optional: OpenAI Integration
OPENAI_API_KEY=your_openai_api_key_here

# Trading Mode
BOT_MODE=SIM  # or LIVE

# Timezone
TZ=Asia/Almaty

# Database Passwords (change these!)
POSTGRES_PASSWORD=secure_password_here
REDIS_PASSWORD=redis_password_here
RABBITMQ_PASSWORD=rabbitmq_password_here
```

### 3. Deploy with Docker

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check service status
docker-compose ps
```

### 4. Access Interfaces

- **Trading Bot API**: http://localhost:3000
- **Grafana Monitoring**: http://localhost:3000 (admin/admin)
- **RabbitMQ Management**: http://localhost:15672
- **PgAdmin**: http://localhost:5050

## 🎮 Telegram Control

### Available Commands

- `/start` - Show main control panel
- `/status` - Current trading status and metrics
- `/pnl` - Profit and loss summary
- `/positions` - View open positions
- `/help` - Command reference

### Inline Controls

The bot provides inline keyboard controls for:

- ▶️ **Start/Stop Trading**
- 📊 **Status & Metrics**
- 💰 **PnL Tracking**
- 📈 **Position Management**
- 🚨 **Emergency Controls**
- ⚙️ **Settings & Configuration**

## 🔧 Configuration

### Trading Settings

Key configuration options in `.env`:

```env
# Risk Management
MAX_DAILY_LOSS_PERCENT=5     # Maximum daily loss (%)
DEFAULT_LEVERAGE=5           # Default leverage
MAX_LEVERAGE=10             # Maximum allowed leverage
MAX_POSITION_PERCENT=30     # Max position size (% of balance)

# AI Configuration
AI_VOLATILITY_THRESHOLD=40   # Volatility threshold for AI usage
AI_CONFIDENCE_THRESHOLD=80   # Minimum confidence for AI decisions
AI_USAGE_COST_LIMIT=50      # Daily AI cost limit ($)
```

### Strategy Configuration

The bot includes three built-in strategies:

1. **Momentum Strategy** - RSI + MACD convergence (15% monthly target)
2. **Mean Reversion Strategy** - Bollinger Bands + Volume (8% monthly target)
3. **Funding Arbitrage Strategy** - Funding rate analysis (3% monthly target)

## 🛡️ Risk Management

### Built-in Protection

- **Daily Loss Limits** - Automatic trading halt
- **Position Sizing** - Risk-adjusted position calculation
- **Leverage Control** - Dynamic leverage based on confidence
- **Liquidation Protection** - Maintains safety buffer
- **Emergency Stops** - Instant position closure

### Risk Levels

- **LOW** - Normal operation
- **MEDIUM** - Increased monitoring
- **HIGH** - Reduced position sizes
- **CRITICAL** - Trading suspended

## 📊 Monitoring

### Health Checks

All services include health endpoints:

```bash
# Check orchestrator health
curl http://localhost:3000/health

# Check all services
docker-compose ps
```

### Metrics & Logging

- **Grafana Dashboards** - Real-time performance metrics
- **Centralized Logging** - Structured logs with Winston
- **Performance Tracking** - Strategy and overall performance
- **Alert System** - Telegram notifications for critical events

## 🧪 Testing

### Development Mode

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Run tests
npm test

# Type checking
npm run lint
```

### Simulation Mode

Start with `BOT_MODE=SIM` to test with:
- Real market data
- Simulated execution
- Realistic slippage and fees
- $100K virtual balance

## 🚨 Emergency Procedures

### Emergency Stop

Via Telegram:
1. Send `/start` command
2. Press 🚨 **Emergency** button
3. Confirm emergency stop

Via API:
```bash
curl -X POST http://localhost:3000/api/emergency/stop
```

### Position Management

Close all positions:
```bash
curl -X POST http://localhost:3004/api/positions/close-all
```

### Service Recovery

Restart specific service:
```bash
docker-compose restart orchestrator
```

Restart all services:
```bash
docker-compose down && docker-compose up -d
```

## 📈 Performance Optimization

### Strategy Tuning

1. Monitor strategy performance via Grafana
2. Adjust weights in Strategy Engine
3. Backtest changes in SIM mode
4. Deploy to LIVE mode gradually

### AI Usage Optimization

- Monitor AI cost vs. performance impact
- Adjust volatility and confidence thresholds
- Review AI decision quality in logs

## 🔐 Security Considerations

### API Keys

- Store API keys securely in `.env`
- Use IP restrictions on Binance API
- Regular key rotation recommended

### Access Control

- Telegram whitelist enforced
- Docker container isolation
- Non-root user execution

### Network Security

- Internal Docker network isolation
- Optional SSL/TLS with nginx
- Firewall configuration recommended

## 🐛 Troubleshooting

### Common Issues

**Services not starting:**
```bash
# Check logs
docker-compose logs orchestrator

# Verify environment
docker-compose config
```

**Database connection issues:**
```bash
# Reset database
docker-compose down -v
docker-compose up -d postgres
```

**Telegram bot not responding:**
- Verify TELEGRAM_TOKEN in .env
- Check TELEGRAM_WHITELIST_IDS format
- Review notifier service logs

### Debug Mode

Enable debug logging:
```env
LOG_LEVEL=debug
```

## 📚 Development

### Adding New Strategies

1. Implement `TradingStrategy` interface
2. Add to `StrategyEngineService`
3. Configure in strategy configs
4. Test in SIM mode

### Extending Services

1. Extend `BaseService` class
2. Implement required abstract methods
3. Add to Docker Compose
4. Update orchestrator dependencies

## 📄 License

MIT License - see LICENSE file for details.

## ⚠️ Disclaimer

This software is for educational and research purposes. Trading cryptocurrencies involves substantial risk. Use at your own risk and never trade with money you cannot afford to lose.

## 🤝 Support

For issues and questions:
1. Check troubleshooting section
2. Review service logs
3. Create GitHub issue with logs and configuration

---

**Happy Trading! 🚀📈**