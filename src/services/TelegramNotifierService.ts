import { Request, Response } from 'express';
import { BaseService } from './BaseService';
import { Config } from '@/config';
import { TelegramNotification, ServiceMessage, TelegramKeyboard } from '@/types';
import { messageQueue } from '@/utils/messageQueue';
import { redis } from '@/utils/redis';
import { db } from '@/utils/database';
import TelegramBot from 'node-telegram-bot-api';
import moment from 'moment-timezone';

interface NotificationConfig {
  enabled: boolean;
  tradeNotifications: boolean;
  positionNotifications: boolean;
  riskNotifications: boolean;
  aiNotifications: boolean;
  errorNotifications: boolean;
}

export class TelegramNotifierService extends BaseService {
  private bot: TelegramBot | null = null;
  private config: NotificationConfig;
  private authorizedUsers: Set<number> = new Set();
  private activeChatId: number | null = null;
  private messageQueue: TelegramNotification[] = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    super('telegram-notifier');
    
    this.config = {
      enabled: !!Config.TELEGRAM_TOKEN,
      tradeNotifications: true,
      positionNotifications: true,
      riskNotifications: true,
      aiNotifications: true,
      errorNotifications: true
    };

    this.setupRoutes();
    this.initializeTelegramBot();
  }

  protected async initialize(): Promise<void> {
    await messageQueue.subscribe('notifications', this.handleNotification.bind(this));
    this.logger.info('Telegram Notifier Service initialized', { 
      enabled: this.config.enabled,
      authorizedUsers: this.authorizedUsers.size 
    });
  }

  protected async cleanup(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
    }
    this.logger.info('Telegram Notifier Service cleaned up');
  }

  private setupRoutes(): void {
    const app = this.getApp();
    app.get('/api/notifications/config', this.asyncHandler(this.getConfigHandler.bind(this)));
    app.post('/api/notifications/send', this.asyncHandler(this.sendNotificationHandler.bind(this)));
    app.get('/api/telegram/status', this.asyncHandler(this.getBotStatusHandler.bind(this)));
  }

  private async getConfigHandler(req: Request, res: Response): Promise<void> {
    this.sendResponse(res, true, this.config);
  }

  private async sendNotificationHandler(req: Request, res: Response): Promise<void> {
    try {
      const notification: TelegramNotification = {
        ...req.body,
        timestamp: Date.now()
      };
      await this.queueNotification(notification);
      this.sendResponse(res, true, { sent: true });
    } catch (error) {
      this.logger.error('Error sending notification', error);
      this.sendResponse(res, false, null, 'Failed to send notification');
    }
  }

  private async getBotStatusHandler(req: Request, res: Response): Promise<void> {
    const status = {
      enabled: this.config.enabled,
      connected: this.bot !== null,
      authorizedUsers: Array.from(this.authorizedUsers),
      activeChatId: this.activeChatId,
      queueSize: this.messageQueue.length
    };
    this.sendResponse(res, true, status);
  }

  private initializeTelegramBot(): void {
    if (!Config.TELEGRAM_TOKEN) {
      this.logger.warn('Telegram token not provided, notifications disabled');
      this.config.enabled = false;
      return;
    }

    try {
      this.bot = new TelegramBot(Config.TELEGRAM_TOKEN, { polling: true });
      this.authorizedUsers = new Set(Config.TELEGRAM_WHITELIST_IDS);
      
      this.setupBotHandlers();
      this.logger.info('Telegram bot initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Telegram bot', error);
      this.config.enabled = false;
    }
  }

  private setupBotHandlers(): void {
    if (!this.bot) return;

    this.bot.on('message', (msg) => {
      this.handleMessage(msg);
    });

    this.bot.on('callback_query', (query) => {
      this.handleCallbackQuery(query);
    });

    this.bot.on('error', (error) => {
      this.logger.error('Telegram bot error', error);
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId || !this.authorizedUsers.has(userId)) {
      await this.bot?.sendMessage(chatId, '❌ Unauthorized access');
      this.logger.warn('Unauthorized Telegram access attempt', { userId, chatId });
      return;
    }

    this.activeChatId = chatId;

    try {
      if (text.startsWith('/')) {
        await this.handleCommand(chatId, text);
      } else {
        await this.handleTextMessage(chatId, text);
      }
    } catch (error) {
      this.logger.error('Error handling Telegram message', error);
      await this.bot?.sendMessage(chatId, '❌ Error processing message');
    }
  }

  private async handleCommand(chatId: number, command: string): Promise<void> {
    const cmd = command.toLowerCase().split(' ')[0];

    switch (cmd) {
      case '/start':
        await this.sendWelcomeMessage(chatId);
        break;
      case '/status':
        await this.sendStatusMessage(chatId);
        break;
      case '/pnl':
        await this.sendPnLSummary(chatId);
        break;
      case '/positions':
        await this.sendPositionsSummary(chatId);
        break;
      case '/help':
        await this.sendHelpMessage(chatId);
        break;
      default:
        await this.bot?.sendMessage(chatId, '❓ Unknown command. Type /help for available commands.');
    }
  }

  private async handleTextMessage(chatId: number, text: string): Promise<void> {
    if (text.toLowerCase().includes('status')) {
      await this.sendStatusMessage(chatId);
    } else if (text.toLowerCase().includes('pnl')) {
      await this.sendPnLSummary(chatId);
    } else {
      await this.bot?.sendMessage(chatId, '💡 Try /status, /pnl, or /positions. Type /help for more options.');
    }
  }

  private async handleCallbackQuery(query: any): Promise<void> {
    const chatId = query.message?.chat?.id;
    const data = query.data;

    if (!chatId || !this.authorizedUsers.has(query.from?.id)) {
      await this.bot?.answerCallbackQuery(query.id, { text: 'Unauthorized' });
      return;
    }

    try {
      await this.bot?.answerCallbackQuery(query.id);

      switch (data) {
        case 'start_trading':
          await this.executeCommand('start');
          break;
        case 'stop_trading':
          await this.executeCommand('stop');
          break;
        case 'status':
          await this.sendStatusMessage(chatId);
          break;
        case 'pnl':
          await this.sendPnLSummary(chatId);
          break;
        case 'emergency_stop':
          await this.executeEmergencyStop(chatId);
          break;
        case 'close_all':
          await this.executeCloseAll(chatId);
          break;
        default:
          await this.bot?.sendMessage(chatId, '❓ Unknown action');
      }
    } catch (error) {
      this.logger.error('Error handling callback query', error);
      await this.bot?.sendMessage(chatId, '❌ Error processing action');
    }
  }

  private async sendWelcomeMessage(chatId: number): Promise<void> {
    const message = `
🤖 **Crypto Trading Bot**

Welcome to your automated trading assistant!

Current Mode: **${Config.BOT_MODE}**
Status: **${await this.getTradingStatus()}**

Use the buttons below to control your bot:
`;

    await this.sendMessageWithKeyboard(chatId, message, this.getMainKeyboard());
  }

  private async sendStatusMessage(chatId: number): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${Config.ORCHESTRATOR_PORT}/api/trading/status`);
      const statusData = await response.json();

      const session = statusData.data?.session;
      const message = `
📊 **Trading Status**

**Session Info:**
${session ? `
• Status: ${session.status}
• Mode: ${session.mode}
• Total Trades: ${session.totalTrades}
• Total PnL: $${session.totalPnL?.toFixed(2) || '0.00'}
• Daily PnL: $${session.dailyPnL?.toFixed(2) || '0.00'}
` : 'No active session'}

**System:**
• Local Time: ${moment().tz(Config.TZ).format('HH:mm:ss DD/MM/YYYY')}
`;

      await this.sendMessageWithKeyboard(chatId, message, this.getStatusKeyboard());
    } catch (error) {
      this.logger.error('Error fetching status', error);
      await this.bot?.sendMessage(chatId, '❌ Failed to fetch status');
    }
  }

  private async sendPnLSummary(chatId: number): Promise<void> {
    try {
      const result = await db.query(`
        SELECT 
          SUM(realized_pnl) as total_pnl,
          SUM(CASE WHEN DATE(timestamp AT TIME ZONE 'UTC+5') = CURRENT_DATE THEN realized_pnl ELSE 0 END) as daily_pnl,
          COUNT(*) as total_trades
        FROM trades 
        WHERE realized_pnl IS NOT NULL AND mode = $1
      `, [Config.BOT_MODE]);

      const pnlData = result[0] || {};
      const message = `
💰 **PnL Summary** (${Config.BOT_MODE} Mode)

• Total PnL: $${parseFloat(pnlData.total_pnl || '0').toFixed(2)}
• Daily PnL: $${parseFloat(pnlData.daily_pnl || '0').toFixed(2)}
• Total Trades: ${pnlData.total_trades || 0}

Updated: ${moment().tz(Config.TZ).format('HH:mm:ss')}
`;

      await this.sendMessageWithKeyboard(chatId, message, this.getBackKeyboard());
    } catch (error) {
      this.logger.error('Error fetching PnL data', error);
      await this.bot?.sendMessage(chatId, '❌ Failed to fetch PnL data');
    }
  }

  private async sendPositionsSummary(chatId: number): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${Config.EXECUTION_SERVICE_PORT}/api/positions`);
      const positionsData = await response.json();
      const positions = positionsData.data || [];

      if (positions.length === 0) {
        await this.bot?.sendMessage(chatId, '📈 No open positions');
        return;
      }

      const message = `
📈 **Open Positions** (${positions.length})

${positions.map((pos: any, index: number) => `
**${index + 1}. ${pos.symbol}**
• Side: ${pos.side}
• Size: ${pos.size}
• PnL: $${pos.unrealizedPnl?.toFixed(2)} ${pos.unrealizedPnl >= 0 ? '🟢' : '🔴'}
`).join('\n')}

Total PnL: $${positions.reduce((sum: number, pos: any) => sum + (pos.unrealizedPnl || 0), 0).toFixed(2)}
`;

      await this.sendMessageWithKeyboard(chatId, message, this.getPositionsKeyboard());
    } catch (error) {
      this.logger.error('Error fetching positions', error);
      await this.bot?.sendMessage(chatId, '❌ Failed to fetch positions');
    }
  }

  private async sendHelpMessage(chatId: number): Promise<void> {
    const message = `
❓ **Help & Commands**

**Available Commands:**
• /start - Show main menu
• /status - Trading status
• /pnl - Profit & Loss summary
• /positions - Open positions
• /help - This help message

**Quick Actions:**
Use the inline buttons for easy access to all features.
`;

    await this.sendMessageWithKeyboard(chatId, message, this.getBackKeyboard());
  }

  private getMainKeyboard(): TelegramKeyboard {
    return {
      inline_keyboard: [
        [
          { text: '▶️ Start', callback_data: 'start_trading' },
          { text: '⏹️ Stop', callback_data: 'stop_trading' }
        ],
        [
          { text: '📊 Status', callback_data: 'status' },
          { text: '💰 PnL', callback_data: 'pnl' }
        ],
        [
          { text: '🚨 Emergency', callback_data: 'emergency_stop' }
        ]
      ]
    };
  }

  private getStatusKeyboard(): TelegramKeyboard {
    return {
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_data: 'status' },
          { text: '💰 PnL', callback_data: 'pnl' }
        ]
      ]
    };
  }

  private getPositionsKeyboard(): TelegramKeyboard {
    return {
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_data: 'positions' },
          { text: '❌ Close All', callback_data: 'close_all' }
        ]
      ]
    };
  }

  private getBackKeyboard(): TelegramKeyboard {
    return {
      inline_keyboard: [
        [{ text: '🔙 Back', callback_data: 'start' }]
      ]
    };
  }

  private async handleNotification(message: ServiceMessage): Promise<void> {
    if (message.type !== 'NOTIFICATION') return;
    const notification: TelegramNotification = message.payload;
    await this.queueNotification(notification);
  }

  private async queueNotification(notification: TelegramNotification): Promise<void> {
    if (!this.config.enabled || !this.shouldSendNotification(notification)) return;
    
    this.messageQueue.push(notification);
    await this.processNotificationQueue();
  }

  private shouldSendNotification(notification: TelegramNotification): boolean {
    switch (notification.type) {
      case 'trade': return this.config.tradeNotifications;
      case 'position': return this.config.positionNotifications;
      case 'risk': return this.config.riskNotifications;
      case 'ai': return this.config.aiNotifications;
      case 'error': return this.config.errorNotifications;
      default: return true;
    }
  }

  private async processNotificationQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const notification = this.messageQueue.shift();
      if (!notification) break;

      try {
        await this.sendNotificationMessage(notification);
        await this.storeNotification(notification);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        this.logger.error('Error sending notification', error);
      }
    }

    this.isProcessingQueue = false;
  }

  private async sendNotificationMessage(notification: TelegramNotification): Promise<void> {
    if (!this.bot || !this.activeChatId) return;

    const icon = this.getNotificationIcon(notification.type, notification.priority);
    const message = `${icon} **${notification.title}**\n\n${notification.message}`;

    await this.sendMessageWithKeyboard(
      this.activeChatId,
      message,
      notification.keyboard || this.getBackKeyboard()
    );
  }

  private getNotificationIcon(type: string, priority?: string): string {
    const icons = {
      trade: '💱',
      position: '📈',
      risk: '⚠️',
      ai: '🤖',
      error: '❌'
    };
    return icons[type as keyof typeof icons] || '📢';
  }

  private async executeCommand(command: string): Promise<void> {
    try {
      let url = '';
      
      switch (command) {
        case 'start':
          url = `http://localhost:${Config.ORCHESTRATOR_PORT}/api/trading/start`;
          break;
        case 'stop':
          url = `http://localhost:${Config.ORCHESTRATOR_PORT}/api/trading/stop`;
          break;
        default:
          throw new Error(`Unknown command: ${command}`);
      }

      const response = await fetch(url, { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        await this.sendMessage(`✅ Command executed: ${command}`);
      } else {
        await this.sendMessage(`❌ Command failed: ${result.error}`);
      }
    } catch (error) {
      this.logger.error('Error executing command', error);
      await this.sendMessage(`❌ Error executing: ${command}`);
    }
  }

  private async executeEmergencyStop(chatId: number): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${Config.ORCHESTRATOR_PORT}/api/emergency/stop`, {
        method: 'POST'
      });

      const result = await response.json();
      const message = result.success ? 
        '🚨 **EMERGENCY STOP EXECUTED**\n\nAll trading halted.' :
        '❌ Emergency stop failed. Check manually.';
      
      await this.bot?.sendMessage(chatId, message);
    } catch (error) {
      this.logger.error('Error executing emergency stop', error);
      await this.bot?.sendMessage(chatId, '❌ Error executing emergency stop');
    }
  }

  private async executeCloseAll(chatId: number): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${Config.EXECUTION_SERVICE_PORT}/api/positions/close-all`, {
        method: 'POST'
      });

      const result = await response.json();
      const message = result.success ? 
        '✅ All positions closed' : 
        '❌ Failed to close positions';
      
      await this.bot?.sendMessage(chatId, message);
    } catch (error) {
      this.logger.error('Error closing positions', error);
      await this.bot?.sendMessage(chatId, '❌ Error closing positions');
    }
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.activeChatId) return;
    await this.bot.sendMessage(this.activeChatId, text, { parse_mode: 'Markdown' });
  }

  private async sendMessageWithKeyboard(chatId: number, text: string, keyboard: TelegramKeyboard): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  private async getTradingStatus(): Promise<string> {
    try {
      const response = await fetch(`http://localhost:${Config.ORCHESTRATOR_PORT}/api/trading/status`);
      const result = await response.json();
      return result.data?.session?.status || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  private async storeNotification(notification: TelegramNotification): Promise<void> {
    try {
      await db.query(
        `INSERT INTO notifications (type, title, message, priority, sent_at, created_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [notification.type, notification.title, notification.message, notification.priority || 'MEDIUM']
      );
    } catch (error) {
      this.logger.error('Error storing notification', error);
    }
  }

  protected async getMetrics(): Promise<Record<string, any>> {
    const baseMetrics = await super.getMetrics();
    return {
      ...baseMetrics,
      enabled: this.config.enabled,
      connected: this.bot !== null,
      authorizedUsers: this.authorizedUsers.size,
      queueSize: this.messageQueue.length,
      activeChatId: this.activeChatId
    };
  }
}

export default TelegramNotifierService;