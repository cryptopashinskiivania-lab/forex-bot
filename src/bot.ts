import { Bot, InlineKeyboard } from 'grammy';
import { env } from './config/env';
import { database } from './db/database';
import { AnalysisService } from './services/AnalysisService';
import { CalendarService, CalendarEvent } from './services/CalendarService';
import { MyfxbookService } from './services/MyfxbookService';
import { SchedulerService } from './services/SchedulerService';
import { DataQualityService } from './services/DataQualityService';
import { initializeQueue } from './services/MessageQueue';
import { parseISO, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { getVolatility } from './data/volatility';
import { aggregateCoreEvents } from './utils/eventAggregation';

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
const dataQualityService = new DataQualityService();

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

// Auto-register users middleware
bot.use(async (ctx, next) => {
  if (ctx.from) {
    database.registerUser(
      ctx.from.id,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );
  }
  await next();
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
  console.log('[Bot] /daily command received');
  try {
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    
    console.log('[Bot] Sending "loading" message...');
    await ctx.reply('📊 Загружаю события за сегодня...');
    console.log('[Bot] Fetching events...');
    const allEvents = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);
    console.log(`[Bot] Got ${allEvents.length} total events`);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const events = allEvents.filter(e => monitoredAssets.includes(e.currency));
    console.log(`[Bot] Filtered to ${events.length} events for user ${userId} (monitoring: ${monitoredAssets.join(', ')})`);

    if (events.length === 0) {
      const assetsText = monitoredAssets.length > 0 
        ? monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
      await ctx.reply(`📅 Сегодня нет событий для ваших активов (${assetsText}).\n\nИзмените активы через /settings`);
      return;
    }

    // Separate events by source
    const forexFactoryEvents = events.filter(e => e.source === 'ForexFactory');
    const myfxbookEvents = events.filter(e => e.source === 'Myfxbook');

    let eventsText = '📅 События за сегодня:\n\n';
    let eventNumber = 0;

    // ForexFactory events
    if (forexFactoryEvents.length > 0) {
      eventsText += '━━━ 📰 ForexFactory ━━━\n\n';
      const ffLines = forexFactoryEvents.map((e) => {
        eventNumber++;
        const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
        const time24 = formatTime24(e);
        const volatility = getVolatility(e.title, e.currency);
        const volatilityText = volatility ? ` 📉 ~${volatility}` : '';
        return `${eventNumber}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}${volatilityText}`;
      });
      eventsText += ffLines.join('\n\n') + '\n\n';
    }

    // Myfxbook events
    if (myfxbookEvents.length > 0) {
      eventsText += '━━━ 📊 Myfxbook ━━━\n\n';
      const mbLines = myfxbookEvents.map((e) => {
        eventNumber++;
        const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
        const time24 = formatTime24(e);
        const volatility = getVolatility(e.title, e.currency);
        const volatilityText = volatility ? ` 📉 ~${volatility}` : '';
        return `${eventNumber}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}${volatilityText}`;
      });
      eventsText += mbLines.join('\n\n');
    }

    // Create keyboard with AI Forecast and AI Results buttons
    const keyboard = new InlineKeyboard();
    keyboard.row(
      { text: '🔮 AI Forecast', callback_data: 'daily_ai_forecast' },
      { text: '📊 AI Results', callback_data: 'daily_ai_results' }
    );

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
    
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    const allEvents = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const eventsRaw = allEvents.filter(e => monitoredAssets.includes(e.currency));
    
    // IMPORTANT: Apply data quality filter for AI Forecast
    const { deliver: events, skipped } = dataQualityService.filterForDelivery(
      eventsRaw,
      { mode: 'ai_forecast', nowUtc: new Date() }
    );
    
    if (skipped.length > 0) {
      console.log(`[Bot] AI Forecast: ${skipped.length} events skipped due to quality issues`);
    }
    
    if (events.length === 0) {
      const assetsText = monitoredAssets.length > 0 
        ? monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
      await ctx.reply(`📅 Нет событий для анализа по вашим активам (${assetsText}).\n\nИзмените активы через /settings`);
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
      await ctx.reply(analysis, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      console.error('Error generating daily analysis:', analysisError);
      await ctx.reply('⚠️ Не удалось сгенерировать анализ. Попробуйте позже.');
    }
  } catch (error) {
    console.error('Error in daily AI forecast callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа.');
  }
});

// Handle AI Results button callback
bot.callbackQuery('daily_ai_results', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: true });
      return;
    }
    
    const userId = ctx.from.id;
    const allEvents = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const eventsRaw = allEvents.filter(e => monitoredAssets.includes(e.currency));
    
    // IMPORTANT: Apply data quality filter for AI Results
    const { deliver: eventsWithResults, skipped } = dataQualityService.filterForDelivery(
      eventsRaw,
      { mode: 'ai_results', nowUtc: new Date() }
    );
    
    if (skipped.length > 0) {
      console.log(`[Bot] AI Results: ${skipped.length} events skipped due to quality issues`);
    }
    
    if (eventsWithResults.length === 0) {
      await ctx.answerCallbackQuery({ 
        text: '⏳ Нет данных для анализа (события еще не вышли)', 
        show_alert: true 
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🧠 Анализирую результаты...', show_alert: false });

    // Prepare events with results for AI analysis
    const eventsForAnalysis = eventsWithResults.map(e => {
      const time24 = formatTime24(e);
      return `${time24} - [${e.currency}] ${e.title} (${e.impact}) | Прогноз: ${e.forecast} | Факт: ${e.actual}`;
    }).join('\n');

    // Get AI analysis of results
    try {
      const analysis = await analysisService.analyzeResults(eventsForAnalysis);
      await ctx.reply(analysis, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      console.error('Error generating results analysis:', analysisError);
      await ctx.reply('⚠️ Не удалось сгенерировать анализ результатов. Попробуйте позже.');
    }
  } catch (error) {
    console.error('Error in daily AI results callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа результатов.');
  }
});

// Handle AI Forecast button callback for /tomorrow command
bot.callbackQuery('tomorrow_ai_forecast', async (ctx) => {
  try {
    await ctx.answerCallbackQuery({ text: '🧠 Анализирую события на завтра...', show_alert: false });
    
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    const allEvents = await aggregateCoreEvents(calendarService, myfxbookService, userId, true);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const eventsRaw = allEvents.filter(e => monitoredAssets.includes(e.currency));
    
    // IMPORTANT: Apply data quality filter for AI Forecast (tomorrow)
    const { deliver: events, skipped } = dataQualityService.filterForDelivery(
      eventsRaw,
      { mode: 'ai_forecast', nowUtc: new Date() }
    );
    
    if (skipped.length > 0) {
      console.log(`[Bot] Tomorrow AI Forecast: ${skipped.length} events skipped due to quality issues`);
    }
    
    if (events.length === 0) {
      const assetsText = monitoredAssets.length > 0 
        ? monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
      await ctx.reply(`📅 Нет событий для анализа по вашим активам (${assetsText}).\n\nИзмените активы через /settings`);
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
      return parts.join(' | ');
    }).join('\n');

    // Get detailed AI analysis for tomorrow
    try {
      const analysis = await analysisService.analyzeDailySchedule(eventsForAnalysis);
      await ctx.reply(analysis, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      console.error('Error generating tomorrow analysis:', analysisError);
      await ctx.reply('⚠️ Не удалось сгенерировать анализ. Попробуйте позже.');
    }
  } catch (error) {
    console.error('Error in tomorrow AI forecast callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа.');
  }
});

// Handle /calendar command (kept for backward compatibility)
bot.command('calendar', async (ctx) => {
  try {
    await ctx.reply('Fetching today’s calendar…');
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    const events = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);

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
  console.log('[Bot] /tomorrow command received');
  try {
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    
    console.log('[Bot] Sending "loading" message...');
    await ctx.reply('📅 Загружаю календарь на завтра...');
    console.log('[Bot] Fetching events...');
    const allEvents = await aggregateCoreEvents(calendarService, myfxbookService, userId, true);
    console.log(`[Bot] Got ${allEvents.length} total events`);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const events = allEvents.filter(e => monitoredAssets.includes(e.currency));
    console.log(`[Bot] Filtered to ${events.length} events for user ${userId} (monitoring: ${monitoredAssets.join(', ')})`);

    if (events.length === 0) {
      const assetsText = monitoredAssets.length > 0 
        ? monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
      await ctx.reply(`📅 Завтра нет событий для ваших активов (${assetsText}).\n\nИзмените активы через /settings`);
      return;
    }

    // Separate events by source
    const forexFactoryEvents = events.filter(e => e.source === 'ForexFactory');
    const myfxbookEvents = events.filter(e => e.source === 'Myfxbook');

    let eventsText = '📅 Календарь на завтра:\n\n';
    let eventNumber = 0;

    // ForexFactory events
    if (forexFactoryEvents.length > 0) {
      eventsText += '━━━ 📰 ForexFactory ━━━\n\n';
      const ffLines = forexFactoryEvents.map((e) => {
        eventNumber++;
        const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
        const time24 = formatTime24(e);
        return `${eventNumber}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}  •  Прогноз: ${e.forecast}  •  Предыдущее: ${e.previous}`;
      });
      eventsText += ffLines.join('\n\n') + '\n\n';
    }

    // Myfxbook events
    if (myfxbookEvents.length > 0) {
      eventsText += '━━━ 📊 Myfxbook ━━━\n\n';
      const mbLines = myfxbookEvents.map((e) => {
        eventNumber++;
        const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
        const time24 = formatTime24(e);
        return `${eventNumber}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}  •  Прогноз: ${e.forecast}  •  Предыдущее: ${e.previous}`;
      });
      eventsText += mbLines.join('\n\n');
    }

    // Create keyboard with AI Forecast button
    const keyboard = new InlineKeyboard();
    keyboard.row({ text: '🔮 AI Forecast', callback_data: 'tomorrow_ai_forecast' });

    await ctx.reply(eventsText, { reply_markup: keyboard });
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
      const userId = ctx.from?.id;
      if (!userId) {
        // Skip context if no userId
        return;
      }
      const events = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);
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
  CAD: '🇨🇦',
  AUD: '🇦🇺',
  CHF: '🇨🇭',
  XAU: '🏆',
  BTC: '₿',
  OIL: '🛢️',
};

// Available assets for monitoring
const AVAILABLE_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'XAU', 'BTC', 'OIL'];

// Helper function to build settings keyboard
function buildSettingsKeyboard(userId: number): InlineKeyboard {
  const monitoredAssets = database.getMonitoredAssets(userId);
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
  const isRssEnabled = database.isRssEnabled(userId);
  const rssStatus = isRssEnabled ? '✅' : '❌';
  keyboard.row({ text: `📡 Внешние источники: ${rssStatus}`, callback_data: 'settings_toggle_rss' });
  
  // Add Quiet Hours toggle button
  const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
  const quietHoursStatus = isQuietHoursEnabled ? '✅' : '❌';
  keyboard.row({ text: `🌙 Тихий режим (23:00-08:00): ${quietHoursStatus}`, callback_data: 'settings_toggle_quiet_hours' });
  
  // Add News Source selection button
  const newsSource = database.getNewsSource(userId);
  const sourceText = newsSource === 'ForexFactory' ? '📰 ForexFactory' : 
                     newsSource === 'Myfxbook' ? '📊 Myfxbook' : 
                     '🔄 Оба источника';
  keyboard.row({ text: `📡 Источник новостей: ${sourceText}`, callback_data: 'settings_news_source' });
  
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
    
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    const monitoredAssets = database.getMonitoredAssets(userId);
    const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
    const newsSource = database.getNewsSource(userId);
    const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : 
                       newsSource === 'Myfxbook' ? 'Myfxbook' : 
                       'Оба источника';
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

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
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    const asset = ctx.match[1];
    
    if (!AVAILABLE_ASSETS.includes(asset)) {
      await ctx.answerCallbackQuery({ text: '❌ Неизвестный актив', show_alert: false });
      return;
    }
    
    // Toggle the asset
    const isNowEnabled = database.toggleAsset(userId, asset);
    const status = isNowEnabled ? 'включен' : 'выключен';
    const flag = ASSET_FLAGS[asset] || '';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets(userId);
    const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
    const newsSource = database.getNewsSource(userId);
    const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : 
                       newsSource === 'Myfxbook' ? 'Myfxbook' : 
                       'Оба источника';
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

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
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    
    // Toggle RSS setting
    const isNowEnabled = database.toggleRss(userId);
    const status = isNowEnabled ? 'включены' : 'выключены';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets(userId);
    const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
    const newsSource = database.getNewsSource(userId);
    const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : 
                       newsSource === 'Myfxbook' ? 'Myfxbook' : 
                       'Оба источника';
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

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
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    
    // Toggle Quiet Hours setting
    const isNowEnabled = database.toggleQuietHours(userId);
    const status = isNowEnabled ? 'включен' : 'выключен';
    
    // Update the message with new keyboard
    const monitoredAssets = database.getMonitoredAssets(userId);
    const newsSource = database.getNewsSource(userId);
    const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : 
                       newsSource === 'Myfxbook' ? 'Myfxbook' : 
                       'Оба источника';
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isNowEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

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

// Handle News Source selection button
bot.callbackQuery('settings_news_source', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    const currentSource = database.getNewsSource(userId);
    
    // Create inline keyboard with source options
    const keyboard = new InlineKeyboard();
    keyboard.row({ text: currentSource === 'ForexFactory' ? '✅ 📰 ForexFactory' : '📰 ForexFactory', callback_data: 'source_forexfactory' });
    keyboard.row({ text: currentSource === 'Myfxbook' ? '✅ 📊 Myfxbook' : '📊 Myfxbook', callback_data: 'source_myfxbook' });
    keyboard.row({ text: currentSource === 'Both' ? '✅ 🔄 Оба источника' : '🔄 Оба источника', callback_data: 'source_both' });
    keyboard.row({ text: '◀️ Назад', callback_data: 'settings_back' });
    
    await ctx.editMessageText('📡 **Выберите источник новостей:**\n\n🔵 **ForexFactory** - основной источник, наиболее надежный\n🟢 **Myfxbook** - дополнительный источник\n🔄 **Оба источника** - максимальное покрытие событий (рекомендуется)', {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error showing news source menu:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при открытии меню', show_alert: false });
  }
});

// Handle news source selection callbacks
bot.callbackQuery(/^source_(forexfactory|myfxbook|both)$/, async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    const source = ctx.match[1];
    
    let sourceValue: 'ForexFactory' | 'Myfxbook' | 'Both';
    let sourceName: string;
    
    if (source === 'forexfactory') {
      sourceValue = 'ForexFactory';
      sourceName = 'ForexFactory';
    } else if (source === 'myfxbook') {
      sourceValue = 'Myfxbook';
      sourceName = 'Myfxbook';
    } else {
      sourceValue = 'Both';
      sourceName = 'Оба источника';
    }
    
    database.setNewsSource(userId, sourceValue);
    await ctx.answerCallbackQuery({ text: `Источник: ${sourceName}`, show_alert: false });
    
    // Return to settings menu
    const monitoredAssets = database.getMonitoredAssets(userId);
    const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

Нажмите на кнопку, чтобы изменить настройку:`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Error handling source selection:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при обновлении', show_alert: false });
  }
});

// Handle back button from news source menu
bot.callbackQuery('settings_back', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    
    const userId = ctx.from.id;
    const monitoredAssets = database.getMonitoredAssets(userId);
    const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
    const newsSource = database.getNewsSource(userId);
    const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : 
                       newsSource === 'Myfxbook' ? 'Myfxbook' : 
                       'Оба источника';
    const keyboard = buildSettingsKeyboard(userId);
    
    const message = `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00 Kyiv)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}

Нажмите на кнопку, чтобы изменить настройку:`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error returning to settings:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при возврате', show_alert: false });
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

// Graceful shutdown handlers
async function shutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  
  try {
    // Stop the scheduler (also closes browsers)
    await schedulerService.stop();
    console.log('✅ Scheduler stopped');
    
    // Stop the bot
    await bot.stop();
    console.log('✅ Bot stopped');
    
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


