import { Bot, InlineKeyboard } from 'grammy';
import { env } from './config/env';
import { database } from './db/database';
import { AnalysisService } from './services/AnalysisService';
import { CalendarService } from './services/CalendarService';
import { SchedulerService } from './services/SchedulerService';
import { initializeQueue } from './services/MessageQueue';

// Create a bot instance
const bot = new Bot(env.BOT_TOKEN);

database.cleanup();

// Initialize message queue (must be done before scheduler starts)
initializeQueue(bot);

// Initialize services
const analysisService = new AnalysisService();
const calendarService = new CalendarService();
const schedulerService = new SchedulerService();

// Set up persistent menu commands (non-fatal on rate limit)
bot.api.setMyCommands([
  { command: 'daily', description: '📊 Сводка за сегодня' },
  { command: 'tomorrow', description: '📅 Календарь на завтра' },
  { command: 'settings', description: '⚙️ Настройки активов' },
  { command: 'ask', description: '❓ Вопрос эксперту' },
  { command: 'id', description: '🆔 Мой ID' },
  { command: 'help', description: 'ℹ️ Помощь' },
]).catch((err) => {
  console.warn('[Bot] setMyCommands failed (e.g. rate limit):', err instanceof Error ? err.message : err);
});

// Debug middleware: Log all incoming updates
bot.use(async (ctx, next) => {
  console.log('Received update:', ctx.update);
  await next();
});

// Handle /start command
bot.command('start', (ctx) => {
  console.log('Start command received');
  ctx.reply('✅ Система онлайн\n\nИспользуйте команды из меню для получения информации о событиях календаря.');
});

// Handle /test command
bot.command('test', async (ctx) => {
  const text = ctx.message?.text?.replace('/test', '').trim();
  
  if (!text) {
    await ctx.reply('Пожалуйста, укажите текст новости для анализа.\nИспользование: /test <текст новости>');
    return;
  }
  
  try {
    await ctx.reply('Анализирую новость...');
    const result = await analysisService.analyzeNews(text);
    
    const sentimentEmoji = result.sentiment === 'Pos' ? '📈' : result.sentiment === 'Neg' ? '📉' : '➡️';
    const reply = `📊 Оценка: ${result.score}/10 ${sentimentEmoji}\n📝 Суть: ${result.summary}\n🧠 Анализ: ${result.reasoning}\n💱 Затронутые пары: ${result.affected_pairs.join(', ') || 'Нет'}`;
    
    await ctx.reply(reply);
  } catch (error) {
    console.error('Error in test command:', error);
    await ctx.reply(`Ошибка при анализе новости: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
});

// Handle /daily command – fetch and display today's events with detailed AI analysis
bot.command('daily', async (ctx) => {
  try {
    await ctx.reply('📊 Загружаю события за сегодня...');
    const events = await calendarService.getEventsForToday();

    if (events.length === 0) {
      await ctx.reply('📅 Сегодня нет событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    // Format events list for quick reference
    const lines = events.map((e, i) => {
      const n = i + 1;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${e.time}`;
    });
    const eventsText = `📅 События за сегодня:\n\n${lines.join('\n\n')}`;

    // Send raw list first as quick reference
    await ctx.reply(eventsText);

    // Prepare detailed events text for AI analysis (with all available data)
    const eventsForAnalysis = events.map(e => {
      const parts = [
        `${e.time} - [${e.currency}] ${e.title} (${e.impact})`
      ];
      if (e.forecast && e.forecast !== '—') {
        parts.push(`Прогноз: ${e.forecast}`);
      }
      if (e.previous && e.previous !== '—') {
        parts.push(`Предыдущее: ${e.previous}`);
      }
      if (e.actual && e.actual !== '—') {
        parts.push(`Факт: ${e.actual}`);
      }
      return parts.join(' | ');
    }).join('\n');

    // Get detailed AI analysis
    try {
      await ctx.reply('🧠 Анализирую события...');
      const analysis = await analysisService.analyzeDailySchedule(eventsForAnalysis);
      await ctx.reply(`📊 Детальный анализ дня:\n\n${analysis}`, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      console.error('Error generating daily analysis:', analysisError);
      await ctx.reply('⚠️ Не удалось сгенерировать анализ. Список событий выше.');
    }
  } catch (error) {
    console.error('Error in daily command:', error);
    await ctx.reply(
      `❌ Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle /calendar command (kept for backward compatibility)
bot.command('calendar', async (ctx) => {
  try {
    await ctx.reply('Fetching today’s calendar…');
    const events = await calendarService.getEventsForToday();

    if (events.length === 0) {
      await ctx.reply('Сегодня нет событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    const lines = events.map((e, i) => {
      const n = i + 1;
      return `${n}. [${e.currency}] ${e.impact}\n   ${e.title}\n   🕐 ${e.time}  •  F: ${e.forecast}  •  P: ${e.previous}`;
    });
    const text = `📅 ForexFactory – Сегодня (Высокое/Среднее влияние, USD GBP EUR JPY NZD)\n\n${lines.join('\n\n')}`;

    await ctx.reply(text);
  } catch (error) {
    console.error('Error in calendar command:', error);
    await ctx.reply(
      `Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle /tomorrow command – fetch and display tomorrow's events
bot.command('tomorrow', async (ctx) => {
  try {
    await ctx.reply('📅 Загружаю календарь на завтра...');
    const events = await calendarService.getEventsForTomorrow();

    if (events.length === 0) {
      await ctx.reply('📅 Завтра нет запланированных событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    const lines = events.map((e, i) => {
      const n = i + 1;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${e.time}  •  Прогноз: ${e.forecast}  •  Предыдущее: ${e.previous}`;
    });
    const text = `📅 Календарь на завтра:\n\n${lines.join('\n\n')}`;

    await ctx.reply(text);
  } catch (error) {
    console.error('Error in tomorrow command:', error);
    await ctx.reply(
      `❌ Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle /id command – get user's chat ID for configuration
bot.command('id', (ctx) => {
  ctx.reply(`🆔 Ваш Chat ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// Handle /ask command
bot.command('ask', async (ctx) => {
  const text = ctx.message?.text?.replace('/ask', '').trim();
  
  if (!text) {
    await ctx.reply('Напишите вопрос после команды. Пример: `/ask Что такое Non-Farm Payrolls?`', { parse_mode: 'Markdown' });
    return;
  }
  
  try {
    await ctx.reply('🧠 Анализирую ваш вопрос...');
    
    // Optionally get current market context (today's events) to provide better answers
    let context: string | undefined;
    try {
      const events = await calendarService.getEventsForToday();
      if (events.length > 0) {
        const eventsForContext = events
          .slice(0, 5) // Limit to first 5 events for context
          .map(e => `${e.time} - [${e.currency}] ${e.title}${e.forecast && e.forecast !== '—' ? ` (Прогноз: ${e.forecast})` : ''}`)
          .join('\n');
        context = `События на сегодня:\n${eventsForContext}`;
      }
    } catch (contextError) {
      // If context fetch fails, continue without it
      console.log('Could not fetch context for question:', contextError);
    }
    
    const answer = await analysisService.answerQuestion(text, context);
    await ctx.reply(`💡 Ответ:\n\n${answer}`);
  } catch (error) {
    console.error('Error in ask command:', error);
    await ctx.reply(`❌ Ошибка при обработке вопроса: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
});

// Asset flags mapping
const ASSET_FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  NZD: '🇳🇿',
  XAU: '🏆',
  BTC: '₿',
  OIL: '🛢️',
};

// Available assets for monitoring
const AVAILABLE_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'NZD', 'XAU', 'BTC', 'OIL'];

// Helper function to build settings keyboard
function buildSettingsKeyboard(): InlineKeyboard {
  const monitoredAssets = database.getMonitoredAssets();
  const keyboard = new InlineKeyboard();
  
  // Add buttons in rows of 3
  for (let i = 0; i < AVAILABLE_ASSETS.length; i += 3) {
    const row = AVAILABLE_ASSETS.slice(i, i + 3).map(asset => {
      const isEnabled = monitoredAssets.includes(asset);
      const flag = ASSET_FLAGS[asset] || '📌';
      const status = isEnabled ? '✅' : '❌';
      return { text: `${status} ${flag} ${asset}`, callback_data: `toggle_${asset}` };
    });
    keyboard.row(...row);
  }
  
  // Add RSS toggle button
  const isRssEnabled = database.isRssEnabled();
  const rssStatus = isRssEnabled ? '✅' : '❌';
  keyboard.row({ text: `📡 Внешние источники: ${rssStatus}`, callback_data: 'settings_toggle_rss' });
  
  // Add "Close" button at the bottom
  keyboard.row({ text: '✅ Готово', callback_data: 'settings_close' });
  
  return keyboard;
}

// Handle /settings command
bot.command('settings', async (ctx) => {
  try {
    const monitoredAssets = database.getMonitoredAssets();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки отслеживаемых активов**

Текущие активные активы: ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}

Нажмите на кнопку, чтобы включить/выключить отслеживание актива:`;
    
    await ctx.reply(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  } catch (error) {
    console.error('Error in settings command:', error);
    await ctx.reply(`❌ Ошибка при загрузке настроек: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
});

// Handle callback queries (button clicks)
bot.callbackQuery(/^toggle_(.+)$/, async (ctx) => {
  try {
    const asset = ctx.match[1];
    
    if (!AVAILABLE_ASSETS.includes(asset)) {
      await ctx.answerCallbackQuery({ text: '❌ Неизвестный актив', show_alert: false });
      return;
    }
    
    // Toggle the asset
    const isNowEnabled = database.toggleAsset(asset);
    const status = isNowEnabled ? 'включен' : 'выключен';
    const flag = ASSET_FLAGS[asset] || '';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки отслеживаемых активов**

Текущие активные активы: ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}

Нажмите на кнопку, чтобы включить/выключить отслеживание актива:`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCallbackQuery({ 
      text: `${flag} ${asset} ${isNowEnabled ? 'включен' : 'выключен'}`, 
      show_alert: false 
    });
  } catch (error) {
    console.error('Error handling callback query:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при обновлении', show_alert: false });
  }
});

// Handle RSS toggle button
bot.callbackQuery('settings_toggle_rss', async (ctx) => {
  try {
    // Toggle RSS setting
    const isNowEnabled = database.toggleRss();
    const status = isNowEnabled ? 'включены' : 'выключены';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки отслеживаемых активов**

Текущие активные активы: ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}

Нажмите на кнопку, чтобы включить/выключить отслеживание актива:`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCallbackQuery({ 
      text: `📡 Внешние источники ${status}`, 
      show_alert: false 
    });
  } catch (error) {
    console.error('Error toggling RSS:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при обновлении', show_alert: false });
  }
});

// Handle settings close button
bot.callbackQuery('settings_close', async (ctx) => {
  try {
    await ctx.deleteMessage();
    await ctx.answerCallbackQuery({ text: 'Настройки сохранены', show_alert: false });
  } catch (error) {
    console.error('Error closing settings:', error);
    // If deleteMessage fails (e.g., message already deleted), just answer the callback
    await ctx.answerCallbackQuery({ text: '✅', show_alert: false }).catch(() => {});
  }
});

// Handle /help command
bot.command('help', (ctx) => {
  const helpText = `ℹ️ **Помощь по командам:**

📊 \`/daily\` - Сводка событий за сегодня с AI-анализом
📅 \`/tomorrow\` - Календарь запланированных событий на завтра
❓ \`/ask\` - Задать вопрос эксперту по Форекс
⚙️ \`/settings\` - Настройки отслеживаемых активов
🆔 \`/id\` - Показать ваш Chat ID
ℹ️ \`/help\` - Показать это сообщение

Бот автоматически отправляет уведомления о важных событиях с анализом влияния на рынок.`;
  
  ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// Error handler
bot.catch((err) => {
  console.error('Bot error:', err);
  // Optionally send error message to user if context is available
  if (err.ctx) {
    err.ctx.reply('❌ Произошла ошибка. Попробуйте позже.').catch(() => {});
  }
});

// Start the scheduler service (before starting bot)
schedulerService.start(bot);

// Start the bot (must be at the very end)
bot.start();

console.log('✅ Bot started with SQLite persistence and Timezone support');

