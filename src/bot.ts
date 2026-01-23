import { Bot, InlineKeyboard } from 'grammy';
import { env } from './config/env';
import { database } from './db/database';
import { AnalysisService } from './services/AnalysisService';
import { CalendarService, CalendarEvent } from './services/CalendarService';
import { MyfxbookService } from './services/MyfxbookService';
import { SchedulerService } from './services/SchedulerService';
import { initializeQueue } from './services/MessageQueue';
import { parseISO, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import crypto from 'crypto';
import { getVolatility } from './data/volatility';

// User states for conversation flow
type UserState = 'WAITING_FOR_QUESTION' | null;
const userStates = new Map<number, UserState>();

// Create a bot instance
const bot = new Bot(env.BOT_TOKEN);

database.cleanup();

// Initialize message queue (must be done before scheduler starts)
initializeQueue(bot);

// Initialize services
const analysisService = new AnalysisService();
const calendarService = new CalendarService();
const myfxbookService = new MyfxbookService();
const schedulerService = new SchedulerService();

// Helper function for deduplication
function md5(str: string): string {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function deduplicationKey(event: CalendarEvent): string {
  let timeKey = event.timeISO || event.time;
  
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const roundedMinutes = Math.floor(eventTime.getMinutes() / 5) * 5;
      const roundedTime = new Date(eventTime);
      roundedTime.setMinutes(roundedMinutes, 0, 0);
      timeKey = roundedTime.toISOString().substring(0, 16);
    } catch {
      // If parsing fails, use original time
    }
  }
  
  return md5(`${timeKey}_${event.currency}`);
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
}

/**
 * Format time to 24-hour format (HH:mm)
 * If timeISO is available, use it; otherwise try to parse the time string
 */
function formatTime24(event: CalendarEvent): string {
  // If we have ISO time, format it directly
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const kyivTime = toZonedTime(eventTime, 'Europe/Kyiv');
      return format(kyivTime, 'HH:mm');
    } catch {
      // Fall through to string parsing
    }
  }
  
  // Try to parse the time string and convert to 24-hour format
  const timeStr = event.time.trim();
  
  // If it's already in 24-hour format (HH:mm), return as is
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    // Normalize to HH:mm format
    const [hours, minutes] = timeStr.split(':');
    return `${hours.padStart(2, '0')}:${minutes}`;
  }
  
  // Try to parse AM/PM format
  const amPmMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
  if (amPmMatch) {
    let hours = parseInt(amPmMatch[1], 10);
    const minutes = amPmMatch[2];
    const ampm = amPmMatch[3].toUpperCase();
    
    if (ampm === 'PM' && hours !== 12) {
      hours += 12;
    } else if (ampm === 'AM' && hours === 12) {
      hours = 0;
    }
    
    return `${hours.toString().padStart(2, '0')}:${minutes}`;
  }
  
  // If we can't parse it, return original (for special cases like "All Day", "Tentative")
  return timeStr;
}

/**
 * Aggregate Core news sources (ForexFactory + Myfxbook) with deduplication
 */
async function aggregateCoreEvents(
  forTomorrow: boolean = false
): Promise<CalendarEvent[]> {
  try {
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      forTomorrow
        ? calendarService.getEventsForTomorrow().catch(err => {
            console.error('[Bot] Error fetching ForexFactory events:', err);
            return [];
          })
        : calendarService.getEventsForToday().catch(err => {
            console.error('[Bot] Error fetching ForexFactory events:', err);
            return [];
          }),
      forTomorrow
        ? myfxbookService.getEventsForTomorrow().catch(err => {
            console.error('[Bot] Error fetching Myfxbook events:', err);
            return [];
          })
        : myfxbookService.getEventsForToday().catch(err => {
            console.error('[Bot] Error fetching Myfxbook events:', err);
            return [];
          }),
    ]);

    // Combine events
    const allEvents = [...forexFactoryEvents, ...myfxbookEvents];
    
    // Deduplicate: if same time (within 5 min) + same currency, keep only one
    const deduplicationMap = new Map<string, CalendarEvent>();
    const seenKeys = new Set<string>();
    
    for (const event of allEvents) {
      const key = deduplicationKey(event);
      
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        deduplicationMap.set(key, event);
      } else {
        const existing = deduplicationMap.get(key);
        if (existing) {
          const existingHasData = !isEmpty(existing.actual) || !isEmpty(existing.forecast);
          const currentHasData = !isEmpty(event.actual) || !isEmpty(event.forecast);
          
          if ((currentHasData && !existingHasData) ||
              (event.impact === 'High' && existing.impact !== 'High') ||
              (event.source === 'ForexFactory' && existing.source !== 'ForexFactory')) {
            deduplicationMap.set(key, event);
          }
        }
      }
    }
    
    return Array.from(deduplicationMap.values());
  } catch (error) {
    console.error('[Bot] Error aggregating Core events:', error);
    // Fallback to ForexFactory only if aggregation fails
    return forTomorrow
      ? calendarService.getEventsForTomorrow().catch(() => [])
      : calendarService.getEventsForToday().catch(() => []);
  }
}

// Helper function to build main menu keyboard
function buildMainMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.row({ text: '❓ Задать вопрос AI', callback_data: 'ask_question' });
  return keyboard;
}

// Set up persistent menu commands (non-fatal on rate limit)
bot.api.setMyCommands([
  { command: 'daily', description: '📊 Сводка за сегодня' },
  { command: 'tomorrow', description: '📅 Календарь на завтра' },
  { command: 'settings', description: '⚙️ Настройки' },
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
  const keyboard = buildMainMenuKeyboard();
  ctx.reply('✅ Система онлайн\n\nИспользуйте команды из меню для получения информации о событиях календаря.', {
    reply_markup: keyboard
  });
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

// Handle /daily command – fetch and display today's events with optional AI analysis
bot.command('daily', async (ctx) => {
  try {
    await ctx.reply('📊 Загружаю события за сегодня...');
    const events = await aggregateCoreEvents(false);

    if (events.length === 0) {
      await ctx.reply('📅 Сегодня нет событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    // Format events list for quick reference with volatility
    const lines = events.map((e, i) => {
      const n = i + 1;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      const time24 = formatTime24(e);
      const volatility = getVolatility(e.title, e.currency);
      const volatilityText = volatility ? ` 📉 ~${volatility}` : '';
      return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}${volatilityText}`;
    });
    const eventsText = `📅 События за сегодня:\n\n${lines.join('\n\n')}`;

    // Create keyboard with AI Forecast button
    const keyboard = new InlineKeyboard();
    keyboard.row({ text: '🤖 AI Forecast', callback_data: 'daily_ai_forecast' });

    // Send list with button for optional AI analysis
    await ctx.reply(eventsText, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error in daily command:', error);
    await ctx.reply(
      `❌ Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle AI Forecast button callback
bot.callbackQuery('daily_ai_forecast', async (ctx) => {
  try {
    await ctx.answerCallbackQuery({ text: '🧠 Анализирую события...', show_alert: false });
    
    const events = await aggregateCoreEvents(false);
    
    if (events.length === 0) {
      await ctx.reply('📅 Нет событий для анализа.');
      return;
    }

    // Prepare detailed events text for AI analysis (with all available data)
    const eventsForAnalysis = events.map(e => {
      const time24 = formatTime24(e);
      const parts = [
        `${time24} - [${e.currency}] ${e.title} (${e.impact})`
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
      const analysis = await analysisService.analyzeDailySchedule(eventsForAnalysis);
      await ctx.reply(`📊 Детальный анализ дня:\n\n${analysis}`, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      console.error('Error generating daily analysis:', analysisError);
      await ctx.reply('⚠️ Не удалось сгенерировать анализ. Попробуйте позже.');
    }
  } catch (error) {
    console.error('Error in daily AI forecast callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа.');
  }
});

// Handle /calendar command (kept for backward compatibility)
bot.command('calendar', async (ctx) => {
  try {
    await ctx.reply('Fetching today’s calendar…');
    const events = await aggregateCoreEvents(false);

    if (events.length === 0) {
      await ctx.reply('Сегодня нет событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    const lines = events.map((e, i) => {
      const n = i + 1;
      const time24 = formatTime24(e);
      return `${n}. [${e.currency}] ${e.impact}\n   ${e.title}\n   🕐 ${time24}  •  F: ${e.forecast}  •  P: ${e.previous}`;
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
    const events = await aggregateCoreEvents(true);

    if (events.length === 0) {
      await ctx.reply('📅 Завтра нет запланированных событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    const lines = events.map((e, i) => {
      const n = i + 1;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      const time24 = formatTime24(e);
      return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}  •  Прогноз: ${e.forecast}  •  Предыдущее: ${e.previous}`;
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

// Handle /ask command (backward compatibility)
bot.command('ask', async (ctx) => {
  if (!ctx.chat) {
    return;
  }
  const text = ctx.message?.text?.replace('/ask', '').trim();
  
  if (!text) {
    // Enter question mode
    userStates.set(ctx.chat.id, 'WAITING_FOR_QUESTION');
    await ctx.reply('Слушаю, задавай вопрос...');
    return;
  }
  
  // Process question immediately if provided
  await processQuestion(ctx, text);
});

// Handle "Задать вопрос AI" button
bot.callbackQuery('ask_question', async (ctx) => {
  if (!ctx.chat) {
    await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить чат', show_alert: false });
    return;
  }
  userStates.set(ctx.chat.id, 'WAITING_FOR_QUESTION');
  await ctx.answerCallbackQuery();
  await ctx.reply('Слушаю, задавай вопрос...');
});

// Helper function to process questions
async function processQuestion(ctx: any, question: string) {
  try {
    await ctx.reply('🧠 Анализирую ваш вопрос...');
    
    // Optionally get current market context (today's events) to provide better answers
    let context: string | undefined;
    try {
      const events = await aggregateCoreEvents(false);
      if (events.length > 0) {
        const eventsForContext = events
          .slice(0, 5) // Limit to first 5 events for context
          .map(e => {
            const time24 = formatTime24(e);
            return `${time24} - [${e.currency}] ${e.title}${e.forecast && e.forecast !== '—' ? ` (Прогноз: ${e.forecast})` : ''}`;
          })
          .join('\n');
        context = `События на сегодня:\n${eventsForContext}`;
      }
    } catch (contextError) {
      // If context fetch fails, continue without it
      console.log('Could not fetch context for question:', contextError);
    }
    
    const answer = await analysisService.answerQuestion(question, context);
    await ctx.reply(`💡 Ответ:\n\n${answer}`);
  } catch (error) {
    console.error('Error in processQuestion:', error);
    await ctx.reply(`❌ Ошибка при обработке вопроса: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
}

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
  
  // Add Quiet Hours toggle button
  const isQuietHoursEnabled = database.isQuietHoursEnabled();
  const quietHoursStatus = isQuietHoursEnabled ? '✅' : '❌';
  keyboard.row({ text: `🌙 Тихий режим (23:00-08:00): ${quietHoursStatus}`, callback_data: 'settings_toggle_quiet_hours' });
  
  // Add "Close" button at the bottom
  keyboard.row({ text: '✅ Готово', callback_data: 'settings_close' });
  
  return keyboard;
}

// Handle /settings command
bot.command('settings', async (ctx) => {
  try {
    // Reset state if user was in question mode
    if (ctx.chat) {
      userStates.delete(ctx.chat.id);
    }
    
    const monitoredAssets = database.getMonitoredAssets();
    const isQuietHoursEnabled = database.isQuietHoursEnabled();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}

Нажмите на кнопку, чтобы изменить настройку:`;
    
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
    const isQuietHoursEnabled = database.isQuietHoursEnabled();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}

Нажмите на кнопку, чтобы изменить настройку:`;
    
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
    const isQuietHoursEnabled = database.isQuietHoursEnabled();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}

Нажмите на кнопку, чтобы изменить настройку:`;
    
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

// Handle Quiet Hours toggle button
bot.callbackQuery('settings_toggle_quiet_hours', async (ctx) => {
  try {
    // Toggle Quiet Hours setting
    const isNowEnabled = database.toggleQuietHours();
    const status = isNowEnabled ? 'включен' : 'выключен';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets();
    const keyboard = buildSettingsKeyboard();
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isNowEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}

Нажмите на кнопку, чтобы изменить настройку:`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCallbackQuery({ 
      text: `🌙 Тихий режим ${status}`, 
      show_alert: false 
    });
  } catch (error) {
    console.error('Error toggling Quiet Hours:', error);
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

// Handle text messages when user is in WAITING_FOR_QUESTION state
// IMPORTANT: This handler must be registered AFTER all command handlers
// to ensure commands are processed first
bot.on('message:text', async (ctx) => {
  if (!ctx.chat) {
    return; // Skip if chat is undefined
  }
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);
  
  // If it's a command, reset state and let command handlers process it
  if (ctx.message.text?.startsWith('/')) {
    if (state === 'WAITING_FOR_QUESTION') {
      userStates.delete(chatId); // Reset state when command is sent
    }
    return; // Let command handlers process the command
  }
  
  // Only process if user is in WAITING_FOR_QUESTION state
  if (state === 'WAITING_FOR_QUESTION') {
    const question = ctx.message.text?.trim();
    if (question) {
      userStates.delete(chatId); // Reset state
      await processQuestion(ctx, question);
    }
  }
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

