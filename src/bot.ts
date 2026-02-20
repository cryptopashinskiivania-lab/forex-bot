import { Bot, InlineKeyboard } from 'grammy';
import { env } from './config/env';
import { database } from './db/database';
import { AnalysisService } from './services/AnalysisService';
import { ForexFactoryCsvService } from './services/ForexFactoryCsvService';
import { CalendarEvent } from './types/calendar';
import { MyfxbookService } from './services/MyfxbookService';
import { SchedulerService, getNotificationGroup, setNotificationGroup } from './services/SchedulerService';
import { DataQualityService } from './services/DataQualityService';
import { initializeQueue } from './services/MessageQueue';
import { initializeAdminAlerts } from './utils/adminAlerts';
import { parseISO, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { aggregateCoreEvents } from './utils/eventAggregation';
import { buildDailyMessage, buildDailyKeyboard } from './utils/dailyMessage';
import { stripRedundantCountryPrefix } from './utils/eventTitleFormat';
import type { EventGroup } from './utils/eventGrouping';

// User states for conversation flow (with TTL 30 min by last activity to limit memory)
type UserState = 'WAITING_FOR_QUESTION' | 'WAITING_TIMEZONE' | null;
const USER_STATE_TTL_MS = 30 * 60 * 1000;
const USER_STATE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const userStateEntries = new Map<number, { state: UserState; lastActivity: number }>();

function setUserState(chatId: number, state: UserState): void {
  userStateEntries.set(chatId, { state, lastActivity: Date.now() });
}

function getUserState(chatId: number): UserState | undefined {
  const entry = userStateEntries.get(chatId);
  if (!entry) return undefined;
  entry.lastActivity = Date.now();
  return entry.state;
}

function deleteUserState(chatId: number): void {
  userStateEntries.delete(chatId);
}

function cleanupExpiredUserStates(): void {
  const now = Date.now();
  for (const [chatId, entry] of userStateEntries.entries()) {
    if (now - entry.lastActivity > USER_STATE_TTL_MS) {
      userStateEntries.delete(chatId);
    }
  }
}

setInterval(cleanupExpiredUserStates, USER_STATE_CLEANUP_INTERVAL_MS);

// Popular timezones; callback_data uses index (tz_0, tz_1, ...) to avoid encoding underscores in IANA ids like America/New_York
const POPULAR_TIMEZONES: { label: string; iana: string }[] = [
  { label: 'Киев', iana: 'Europe/Kyiv' },
  { label: 'Москва', iana: 'Europe/Moscow' },
  { label: 'Лондон', iana: 'Europe/London' },
  { label: 'Берлин', iana: 'Europe/Berlin' },
  { label: 'Нью-Йорк', iana: 'America/New_York' },
  { label: 'Лос-Анджелес', iana: 'America/Los_Angeles' },
  { label: 'Токио', iana: 'Asia/Tokyo' },
  { label: 'Дубай', iana: 'Asia/Dubai' },
  { label: 'Сингапур', iana: 'Asia/Singapore' },
  { label: 'UTC', iana: 'UTC' },
];

const TIMEZONE_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  POPULAR_TIMEZONES.map((t) => [t.iana, t.label])
);

function timezoneToCallbackData(index: number): string {
  return 'tz_' + index;
}

function getTimezoneDisplayName(iana: string): string {
  return TIMEZONE_DISPLAY_NAMES[iana] ?? iana;
}

function isValidIANATimezone(iana: string): boolean {
  try {
    new Intl.DateTimeFormat('ru', { timeZone: iana });
    return true;
  } catch {
    return false;
  }
}

const CITY_TO_IANA: Record<string, string> = {
  'киев': 'Europe/Kyiv',
  'kiev': 'Europe/Kyiv',
  'kyiv': 'Europe/Kyiv',
  'москва': 'Europe/Moscow',
  'moscow': 'Europe/Moscow',
  'лондон': 'Europe/London',
  'london': 'Europe/London',
  'берлин': 'Europe/Berlin',
  'berlin': 'Europe/Berlin',
  'нью-йорк': 'America/New_York',
  'new york': 'America/New_York',
  'newyork': 'America/New_York',
  'лос-анджелес': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  'токио': 'Asia/Tokyo',
  'tokyo': 'Asia/Tokyo',
  'дубай': 'Asia/Dubai',
  'dubai': 'Asia/Dubai',
  'сингапур': 'Asia/Singapore',
  'singapore': 'Asia/Singapore',
};

function resolveTimezoneInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (CITY_TO_IANA[key]) {
    return CITY_TO_IANA[key];
  }
  if (trimmed.includes('/') && isValidIANATimezone(trimmed)) {
    return trimmed;
  }
  if (isValidIANATimezone(trimmed)) {
    return trimmed;
  }
  return null;
}

// Create a bot instance
const bot = new Bot(env.BOT_TOKEN);

database.cleanup();

// Startup diagnostic for notifications (cwd/DB path matter after PM2 or backup)
console.log(
  '[Startup] cwd=%s | db=%s | users=%d',
  process.cwd(),
  database.getDbPath(),
  database.getUserCount()
);

// Initialize message queue (must be done before scheduler starts)
initializeQueue(bot);

// Initialize admin alerts for data quality monitoring
initializeAdminAlerts(bot);

// Initialize services
const analysisService = new AnalysisService();
const forexFactoryService = new ForexFactoryCsvService();
const myfxbookService = new MyfxbookService();
const schedulerService = new SchedulerService();
const dataQualityService = new DataQualityService();

/** Кэш групп для callback group_details / ai_single (синхронизирован с notificationGroupEntries, 1h TTL) */
const groupsCache = new Map<string, EventGroup>();

const GROUPS_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Возвращает группу по id из кэша уведомлений (1h TTL) или из локального groupsCache.
 * Используется в group_details и ai_single для единого источника с TTL.
 */
function getCachedGroup(groupId: string): EventGroup | undefined {
  const fromNotification = getNotificationGroup(groupId);
  if (fromNotification) return fromNotification;
  return groupsCache.get(groupId);
}

function cleanupExpiredGroupsCache(): void {
  for (const groupId of groupsCache.keys()) {
    if (getNotificationGroup(groupId) === undefined) {
      groupsCache.delete(groupId);
    }
  }
}

setInterval(cleanupExpiredGroupsCache, GROUPS_CACHE_CLEANUP_INTERVAL_MS);

/** Дневной лимит AI-запросов на пользователя (24h TTL) */
const AI_QUOTA_PER_DAY = 20;
const AI_QUOTA_TTL_MS = 24 * 60 * 60 * 1000;

const userAiQuota = new Map<number, { count: number; resetAt: number }>();

/**
 * Проверяет, разрешён ли пользователю ещё один AI-запрос.
 * При истечении окна (24h) счётчик обнуляется.
 * @returns { allowed, resetInMs } — можно ли запрос и через сколько мс обнулится лимит
 */
function checkAiQuota(userId: number): { allowed: boolean; resetInMs: number } {
  const entry = userAiQuota.get(userId);
  const now = Date.now();
  if (entry && now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + AI_QUOTA_TTL_MS;
  }
  if (!entry || entry.count < AI_QUOTA_PER_DAY) {
    return { allowed: true, resetInMs: 0 };
  }
  return { allowed: false, resetInMs: Math.max(0, (entry.resetAt ?? now + AI_QUOTA_TTL_MS) - now) };
}

/**
 * Увеличивает счётчик использований AI для пользователя (вызывать перед запросом к AI).
 */
function incrementAiQuota(userId: number): void {
  let entry = userAiQuota.get(userId);
  const now = Date.now();
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + AI_QUOTA_TTL_MS };
    userAiQuota.set(userId, entry);
  }
  entry.count += 1;
}

/**
 * Format event time to 24-hour format (HH:mm) in the user's timezone
 */
function formatTime24(event: CalendarEvent, timezone: string): string {
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const localTime = toZonedTime(eventTime, timezone);
      return format(localTime, 'HH:mm');
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

/** Экранирование символов для Telegram Markdown */
function escapeMarkdown(s: string): string {
  return s.replace(/([_*\[\]`])/g, '\\$1');
}

/**
 * Получить контент /daily или /tomorrow для пользователя: текст, клавиатура и заполнить groupsCache.
 */
async function getDailyOrTomorrowContent(
  userId: number,
  forTomorrow: boolean
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
  grouped: Array<EventGroup | CalendarEvent>;
}> {
  const allEvents = await aggregateCoreEvents(forexFactoryService, myfxbookService, userId, forTomorrow);
  const monitoredAssets = database.getMonitoredAssets(userId);
  const eventsRaw = allEvents.filter((e) => monitoredAssets.includes(e.currency));
  const { deliver: events } = dataQualityService.filterForDelivery(eventsRaw, {
    mode: 'general',
    nowUtc: new Date(),
    forScheduler: false,
  });
  const userTz = database.getTimezone(userId);
  const { text, empty, grouped } = buildDailyMessage(events, userTz, monitoredAssets, forTomorrow);
  grouped.filter((g) => 'events' in g).forEach((g) => {
    const eg = g as EventGroup;
    groupsCache.set(eg.groupId, eg);
    setNotificationGroup(eg.groupId, eg);
  });
  const keyboard = buildDailyKeyboard(grouped);
  return { text, keyboard, grouped };
}

// Helper function to build main menu keyboard
function buildMainMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.row({ text: '❓ Задать вопрос AI', callback_data: 'ask_question' });
  return keyboard;
}

// Команды для обычных пользователей (без /stats)
const defaultCommands = [
  { command: 'daily', description: '📊 Сводка за сегодня' },
  { command: 'tomorrow', description: '📅 События завтра' },
  { command: 'settings', description: '⚙️ Настройки' },
  { command: 'help', description: 'ℹ️ Помощь' },
];

bot.api.setMyCommands(defaultCommands).catch((err) => {
  console.warn('[Bot] setMyCommands failed (e.g. rate limit):', err instanceof Error ? err.message : err);
});

// Для админа — те же команды плюс /stats (видна только в чате админа)
if (env.ADMIN_CHAT_ID) {
  const adminCommands = [
    ...defaultCommands,
    { command: 'stats', description: 'Статистика бота' },
  ];
  bot.api
    .setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: Number(env.ADMIN_CHAT_ID) } })
    .catch((err) => {
      console.warn('[Bot] setMyCommands (admin scope) failed:', err instanceof Error ? err.message : err);
    });
}

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

// Analytics: log user events (commands, callbacks)
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await next();
    return;
  }
  if (ctx.callbackQuery?.data) {
    const data = ctx.callbackQuery.data;
    const eventName = data.startsWith('toggle_') ? 'toggle_asset' : data;
    database.logUserEvent(userId, 'callback', eventName);
  } else if (ctx.message?.text?.startsWith('/')) {
    const match = ctx.message.text.trim().split(/\s+/)[0]?.replace(/^\//, '');
    if (match) {
      database.logUserEvent(userId, 'command', match.toLowerCase());
    }
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

// Handle /debug_notifications – run notification diagnostics (no sends)
bot.command('debug_notifications', async (ctx) => {
  try {
    await ctx.reply('🔍 Запускаю диагностику оповещений (без отправки сообщений)...');
    const report = await schedulerService.runNotificationDiagnostics();
    const MAX_LEN = 4000;
    if (report.length <= MAX_LEN) {
      await ctx.reply(`<pre>${report.replace(/</g, '&lt;')}</pre>`, { parse_mode: 'HTML' });
    } else {
      for (let i = 0; i < report.length; i += MAX_LEN) {
        const chunk = report.slice(i, i + MAX_LEN);
        await ctx.reply(`<pre>${chunk.replace(/</g, '&lt;')}</pre>`, { parse_mode: 'HTML' });
      }
    }
  } catch (error) {
    console.error('[debug_notifications] Error:', error);
    await ctx.reply(`❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`);
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
    const { text, keyboard } = await getDailyOrTomorrowContent(userId, false);
    await ctx.reply(text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error in daily command:', error);
    await ctx.reply(
      `❌ Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle /tomorrow command – fetch and display next day's calendar events
bot.command('tomorrow', async (ctx) => {
  console.log('[Bot] /tomorrow command received');
  try {
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    const userId = ctx.from.id;
    await ctx.reply('📅 Загружаю события на завтра...');
    const { text, keyboard } = await getDailyOrTomorrowContent(userId, true);
    await ctx.reply(text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error in tomorrow command:', error);
    await ctx.reply(
      `❌ Ошибка при загрузке календаря: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
});

// Handle AI Forecast: анализ по всем актуальным новостям дня (Groq)
bot.callbackQuery('daily_ai_forecast', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: true });
      return;
    }
    const userId = ctx.from.id;
    const quota = checkAiQuota(userId);
    if (!quota.allowed) {
      const hours = Math.ceil(quota.resetInMs / (60 * 60 * 1000));
      await ctx.answerCallbackQuery({
        text: `⚠️ Превышен дневной лимит AI (20 запросов). Обнулится через ${hours} ч.`,
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🧠 Анализирую события...', show_alert: false });
    
    const allEvents = await aggregateCoreEvents(forexFactoryService, myfxbookService, userId, false);
    
    // Filter events by user's monitored assets
    const monitoredAssets = database.getMonitoredAssets(userId);
    const eventsRaw = allEvents.filter(e => monitoredAssets.includes(e.currency));
    
    // AI Forecast: анализ по всем актуальным новостям дня (включая уже вышедшие) — Groq агент
    const { deliver: events, skipped } = dataQualityService.filterForDelivery(
      eventsRaw,
      { mode: 'general', nowUtc: new Date(), forScheduler: false }
    );
    
    if (skipped.length > 0) {
      console.log(`[Bot] AI Forecast: ${skipped.length} events skipped due to quality issues`);
      // Log skipped issues to database for quality monitoring
      skipped.forEach(issue => {
        database.logDataIssue(
          issue.eventId,
          issue.source,
          issue.type,
          issue.message,
          issue.details
        );
      });
    }
    
    if (events.length === 0) {
      const assetsText = monitoredAssets.length > 0 
        ? monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
      await ctx.reply(`📅 Нет событий для анализа по вашим активам (${assetsText}).\n\nИзмените активы через /settings`);
      return;
    }

    // Prepare detailed events text for AI analysis (with all available data)
    const userTz = database.getTimezone(userId);
    const eventsForAnalysis = events.map(e => {
      const time24 = formatTime24(e, userTz);
      const title = stripRedundantCountryPrefix(e.currency, e.title);
      const parts = [
        `${time24} - [${e.currency}] ${title} (${e.impact})`
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

    // Additional validation: check if prepared string is not empty
    if (!eventsForAnalysis.trim()) {
      await ctx.reply('⚠️ Не удалось подготовить данные для анализа.');
      return;
    }

    // Get detailed AI analysis
    try {
      incrementAiQuota(userId);
      const analysis = await analysisService.analyzeDailySchedule(eventsForAnalysis);
      await ctx.reply(analysis, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      const errMsg = analysisError instanceof Error ? analysisError.message : String(analysisError);
      console.error('[Bot] AI Forecast error:', errMsg, analysisError);
      const isDailyLimit = /tokens per day|TPD|rate limit reached/i.test(errMsg);
      const isRateLimit = /429|rate limit|too many requests/i.test(errMsg);
      await ctx.reply(
        isDailyLimit
          ? '⚠️ Исчерпан дневной лимит запросов к AI (Groq). Попробуйте завтра или обновите тариф: console.groq.com'
          : isRateLimit
            ? '⚠️ Превышен лимит запросов к AI. Подождите 1–2 минуты и попробуйте снова.'
            : '⚠️ Не удалось сгенерировать анализ. Попробуйте позже.'
      );
    }
  } catch (error) {
    console.error('Error in daily AI forecast callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа.');
  }
});

const MAX_EVENT_BUTTONS = 10;

// Group details: short header + buttons for AI analysis per event
bot.callbackQuery(/^group_details_(.+)$/, async (ctx) => {
  try {
    const groupId = ctx.match[1];
    const group = getCachedGroup(groupId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Group expired, use /daily again', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const header = `📊 ${escapeMarkdown(group.title)} (${group.events.length} events)`;
    const eventsSlice = group.events.slice(0, MAX_EVENT_BUTTONS);
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < eventsSlice.length; i += 2) {
      const a = eventsSlice[i];
      const labelA = `${i + 1}. ${a.title.length > 18 ? a.title.slice(0, 15) + '...' : a.title}`;
      if (i + 1 < eventsSlice.length) {
        const b = eventsSlice[i + 1];
        const labelB = `${i + 2}. ${b.title.length > 18 ? b.title.slice(0, 15) + '...' : b.title}`;
        keyboard.row(
          { text: labelA, callback_data: `ai_single_${groupId}_${i}` },
          { text: labelB, callback_data: `ai_single_${groupId}_${i + 1}` }
        );
      } else {
        keyboard.row({ text: labelA, callback_data: `ai_single_${groupId}_${i}` });
      }
    }
    keyboard.row({ text: '🔙 Back to daily', callback_data: 'back_to_daily' });
    await ctx.editMessageText(header, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Error in group_details callback:', err);
    await ctx.answerCallbackQuery({ text: 'Error loading group', show_alert: true }).catch(() => {});
  }
});

// Single event AI analysis with prev/next
bot.callbackQuery(/^ai_single_(.+)_(\d+)$/, async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: 'Error', show_alert: true });
      return;
    }
    const userId = ctx.from.id;
    const quota = checkAiQuota(userId);
    if (!quota.allowed) {
      const hours = Math.ceil(quota.resetInMs / (60 * 60 * 1000));
      await ctx.answerCallbackQuery({
        text: `⚠️ Превышен дневной лимит AI (20 запросов). Обнулится через ${hours} ч.`,
        show_alert: true,
      });
      return;
    }
    const groupId = ctx.match[1];
    const eventIdx = parseInt(ctx.match[2], 10);
    const group = getCachedGroup(groupId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Group expired, use /daily again', show_alert: true });
      return;
    }
    const event = group.events[eventIdx];
    if (!event) {
      await ctx.answerCallbackQuery({ text: 'Event not found', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🧠 Analyzing...', show_alert: false });
    incrementAiQuota(userId);
    const eventText = [
      `${event.title}.`,
      `Currency: ${event.currency}.`,
      `Impact: ${event.impact}.`,
      `Actual: ${event.actual || '—'}.`,
      `Forecast: ${event.forecast || '—'}.`,
      `Previous: ${event.previous || '—'}.`,
    ].join(' ');
    const analysis = await analysisService.analyzeNews(eventText, event.source);
    const sentimentEmoji = analysis.sentiment === 'Pos' ? '📈' : analysis.sentiment === 'Neg' ? '📉' : '➡️';
    const lines = [
      `🧠 AI Analysis: ${escapeMarkdown(event.title)}`,
      '',
      `📊 Impact Score: ${analysis.score}/10 ${sentimentEmoji}`,
      `📝 Summary: ${escapeMarkdown(analysis.summary)}`,
      `💱 Affected Pairs: ${(analysis.affected_pairs || []).join(', ')}`,
      `🧠 Reasoning: ${escapeMarkdown(analysis.reasoning)}`,
    ];
    const keyboard = new InlineKeyboard();
    const prevNext: { text: string; callback_data: string }[] = [];
    if (eventIdx > 0) {
      prevNext.push({ text: '◀️ Prev event', callback_data: `ai_single_${groupId}_${eventIdx - 1}` });
    }
    if (eventIdx < group.events.length - 1) {
      prevNext.push({ text: 'Next event ▶️', callback_data: `ai_single_${groupId}_${eventIdx + 1}` });
    }
    if (prevNext.length > 0) {
      keyboard.row(...prevNext);
    }
    keyboard.row({ text: '🔙 Back to group', callback_data: `group_details_${groupId}` });
    await ctx.editMessageText(lines.join('\n'), {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Error in ai_single callback:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isLimit = /tokens per day|TPD|rate limit|429/i.test(msg);
    await ctx.answerCallbackQuery({
      text: isLimit ? 'AI limit reached, try later' : 'Analysis failed',
      show_alert: true,
    }).catch(() => {});
  }
});

// Notification group: View Results (from scheduler group notification)
bot.callbackQuery(/^notify_group_(.+)$/, async (ctx) => {
  try {
    const groupId = ctx.match[1];
    const group = getNotificationGroup(groupId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Notification expired, use /daily to view current events', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const header = `${escapeMarkdown(group.title)} (${group.time})`;
    const rows: string[] = ['Event | Actual | Forecast', '—'];
    const maxTitleLen = 25;
    for (const e of group.events) {
      const shortTitle = e.title.length > maxTitleLen ? e.title.slice(0, maxTitleLen - 3) + '...' : e.title;
      const actual = (e.actual || '—').trim();
      const forecast = (e.forecast || '—').trim();
      rows.push(`${escapeMarkdown(shortTitle)} | ${escapeMarkdown(actual)} | ${escapeMarkdown(forecast)}`);
    }
    const eventsSlice = group.events.slice(0, MAX_EVENT_BUTTONS);
    const moreCount = group.events.length - MAX_EVENT_BUTTONS;
    const moreText = moreCount > 0 ? `\n\n_… and ${moreCount} more_` : '';
    const body = rows.join('\n') + moreText;
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < eventsSlice.length; i += 2) {
      const a = eventsSlice[i];
      const labelA = `${i + 1}. ${a.title.length > 18 ? a.title.slice(0, 15) + '...' : a.title}`;
      if (i + 1 < eventsSlice.length) {
        const b = eventsSlice[i + 1];
        const labelB = `${i + 2}. ${b.title.length > 18 ? b.title.slice(0, 15) + '...' : b.title}`;
        keyboard.row(
          { text: labelA, callback_data: `notify_ai_single_${groupId}_${i}` },
          { text: labelB, callback_data: `notify_ai_single_${groupId}_${i + 1}` }
        );
      } else {
        keyboard.row({ text: labelA, callback_data: `notify_ai_single_${groupId}_${i}` });
      }
    }
    await ctx.editMessageText(`${header}\n\n${body}`, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Error in notify_group_ callback:', err);
    await ctx.answerCallbackQuery({ text: 'Error loading group', show_alert: true }).catch(() => {});
  }
});

// Notification group: AI Analysis — show list of events to choose for AI
bot.callbackQuery(/^notify_ai_(.+)$/, async (ctx) => {
  try {
    const groupId = ctx.match[1];
    const group = getNotificationGroup(groupId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Notification expired, use /daily to view current events', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const header = `🧠 AI Analysis: ${escapeMarkdown(group.title)} (${group.time})\n\nChoose an event:`;
    const keyboard = new InlineKeyboard();
    const eventsSlice = group.events.slice(0, MAX_EVENT_BUTTONS);
    for (let i = 0; i < eventsSlice.length; i += 2) {
      const a = eventsSlice[i];
      const labelA = `${i + 1}. ${a.title.length > 18 ? a.title.slice(0, 15) + '...' : a.title}`;
      if (i + 1 < eventsSlice.length) {
        const b = eventsSlice[i + 1];
        const labelB = `${i + 2}. ${b.title.length > 18 ? b.title.slice(0, 15) + '...' : b.title}`;
        keyboard.row(
          { text: labelA, callback_data: `notify_ai_single_${groupId}_${i}` },
          { text: labelB, callback_data: `notify_ai_single_${groupId}_${i + 1}` }
        );
      } else {
        keyboard.row({ text: labelA, callback_data: `notify_ai_single_${groupId}_${i}` });
      }
    }
    const moreCount = group.events.length - MAX_EVENT_BUTTONS;
    const moreText = moreCount > 0 ? `\n\n_… and ${moreCount} more_` : '';
    await ctx.editMessageText(header + moreText, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Error in notify_ai_ callback:', err);
    await ctx.answerCallbackQuery({ text: 'Error loading group', show_alert: true }).catch(() => {});
  }
});

// Notification group: single event AI (from notify_group_ / notify_ai_)
bot.callbackQuery(/^notify_ai_single_(.+)_(\d+)$/, async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: 'Error', show_alert: true });
      return;
    }
    const userId = ctx.from.id;
    const quota = checkAiQuota(userId);
    if (!quota.allowed) {
      const hours = Math.ceil(quota.resetInMs / (60 * 60 * 1000));
      await ctx.answerCallbackQuery({
        text: `⚠️ Превышен дневной лимит AI (20 запросов). Обнулится через ${hours} ч.`,
        show_alert: true,
      });
      return;
    }
    const groupId = ctx.match[1];
    const eventIdx = parseInt(ctx.match[2], 10);
    const group = getNotificationGroup(groupId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Notification expired, use /daily to view current events', show_alert: true });
      return;
    }
    const event = group.events[eventIdx];
    if (!event) {
      await ctx.answerCallbackQuery({ text: 'Event not found', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🧠 Analyzing...', show_alert: false });
    incrementAiQuota(userId);
    const eventText = [
      `${event.title}.`,
      `Currency: ${event.currency}.`,
      `Impact: ${event.impact}.`,
      `Actual: ${event.actual || '—'}.`,
      `Forecast: ${event.forecast || '—'}.`,
      `Previous: ${event.previous || '—'}.`,
    ].join(' ');
    const analysis = await analysisService.analyzeNews(eventText, event.source);
    const sentimentEmoji = analysis.sentiment === 'Pos' ? '📈' : analysis.sentiment === 'Neg' ? '📉' : '➡️';
    const lines = [
      `🧠 AI Analysis: ${escapeMarkdown(event.title)}`,
      '',
      `📊 Impact Score: ${analysis.score}/10 ${sentimentEmoji}`,
      `📝 Summary: ${escapeMarkdown(analysis.summary)}`,
      `💱 Affected Pairs: ${(analysis.affected_pairs || []).join(', ')}`,
      `🧠 Reasoning: ${escapeMarkdown(analysis.reasoning)}`,
    ];
    const keyboard = new InlineKeyboard();
    const prevNext: { text: string; callback_data: string }[] = [];
    if (eventIdx > 0) {
      prevNext.push({ text: '◀️ Prev event', callback_data: `notify_ai_single_${groupId}_${eventIdx - 1}` });
    }
    if (eventIdx < group.events.length - 1) {
      prevNext.push({ text: 'Next event ▶️', callback_data: `notify_ai_single_${groupId}_${eventIdx + 1}` });
    }
    if (prevNext.length > 0) {
      keyboard.row(...prevNext);
    }
    keyboard.row({ text: '🔙 Back to group', callback_data: `notify_group_${groupId}` });
    await ctx.editMessageText(lines.join('\n'), {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('Error in notify_ai_single_ callback:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isLimit = /tokens per day|TPD|rate limit|429/i.test(msg);
    await ctx.answerCallbackQuery({
      text: isLimit ? 'AI limit reached, try later' : 'Analysis failed',
      show_alert: true,
    }).catch(() => {});
  }
});

// Back to daily: regenerate daily message and edit
bot.callbackQuery('back_to_daily', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: 'Error', show_alert: true });
      return;
    }
    const userId = ctx.from.id;
    const { text, keyboard } = await getDailyOrTomorrowContent(userId, false);
    await ctx.editMessageText(text, { reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error('Error in back_to_daily callback:', err);
    await ctx.answerCallbackQuery({ text: 'Error loading daily', show_alert: true }).catch(() => {});
  }
});

// Handle AI Results: анализ уже вышедших новостей (Groq)
bot.callbackQuery('daily_ai_results', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: true });
      return;
    }
    const userId = ctx.from.id;
    const quota = checkAiQuota(userId);
    if (!quota.allowed) {
      const hours = Math.ceil(quota.resetInMs / (60 * 60 * 1000));
      await ctx.answerCallbackQuery({
        text: `⚠️ Превышен дневной лимит AI (20 запросов). Обнулится через ${hours} ч.`,
        show_alert: true,
      });
      return;
    }
    const allEvents = await aggregateCoreEvents(forexFactoryService, myfxbookService, userId, false);
    
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
      // Log skipped issues to database for quality monitoring
      skipped.forEach(issue => {
        database.logDataIssue(
          issue.eventId,
          issue.source,
          issue.type,
          issue.message,
          issue.details
        );
      });
    }
    
    if (eventsWithResults.length === 0) {
      await ctx.answerCallbackQuery({ 
        text: '⏳ Нет данных для анализа (события еще не вышли)', 
        show_alert: true 
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🧠 Анализирую результаты...', show_alert: false });

    const userTz = database.getTimezone(userId);
    const eventsForAnalysis = eventsWithResults.map(e => {
      const time24 = formatTime24(e, userTz);
      const title = stripRedundantCountryPrefix(e.currency, e.title);
      return `${time24} - [${e.currency}] ${title} (${e.impact}) | Прогноз: ${e.forecast} | Факт: ${e.actual}`;
    }).join('\n');

    // Additional validation: check if prepared string is not empty
    if (!eventsForAnalysis.trim()) {
      await ctx.reply('⚠️ Не удалось подготовить данные для анализа результатов.');
      return;
    }

    // Get AI analysis of results
    try {
      incrementAiQuota(userId);
      const analysis = await analysisService.analyzeResults(eventsForAnalysis);
      await ctx.reply(analysis, { parse_mode: 'Markdown' });
    } catch (analysisError) {
      const errMsg = analysisError instanceof Error ? analysisError.message : String(analysisError);
      console.error('[Bot] AI Results error:', errMsg, analysisError);
      const isDailyLimit = /tokens per day|TPD|rate limit reached/i.test(errMsg);
      const isRateLimit = /429|rate limit|too many requests/i.test(errMsg);
      await ctx.reply(
        isDailyLimit
          ? '⚠️ Исчерпан дневной лимит запросов к AI (Groq). Попробуйте завтра или обновите тариф: console.groq.com'
          : isRateLimit
            ? '⚠️ Превышен лимит запросов к AI. Подождите 1–2 минуты и попробуйте снова.'
            : '⚠️ Не удалось сгенерировать анализ результатов. Попробуйте позже.'
      );
    }
  } catch (error) {
    console.error('Error in daily AI results callback:', error);
    await ctx.reply('❌ Ошибка при генерации анализа результатов.');
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
    const events = await aggregateCoreEvents(forexFactoryService, myfxbookService, userId, false);

    if (events.length === 0) {
      await ctx.reply('Сегодня нет событий с высоким/средним влиянием для USD, GBP, EUR, JPY, NZD.');
      return;
    }

    const userTz = database.getTimezone(userId);
    const lines = events.map((e, i) => {
      const n = i + 1;
      const time24 = formatTime24(e, userTz);
      const title = stripRedundantCountryPrefix(e.currency, e.title);
      return `${n}. [${e.currency}] ${e.impact}\n   ${title}\n   🕐 ${time24}  •  F: ${e.forecast}  •  P: ${e.previous}`;
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

// Handle /id command – get user's chat ID for configuration
bot.command('id', (ctx) => {
  ctx.reply(`🆔 Ваш Chat ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// Handle /stats command – только для админа, статистика бота
bot.command('stats', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    const adminChatId = env.ADMIN_CHAT_ID ? parseInt(env.ADMIN_CHAT_ID, 10) : null;
    if (adminChatId === null || ctx.from.id !== adminChatId) {
      await ctx.reply('❌ Команда доступна только администратору');
      return;
    }

    const allUsers = database.getAllUsers();
    const totalUsers = allUsers.length;
    const analytics = database.getAnalyticsStats(30);
    const notifications24h = database.getSentNotificationsCount(1);
    const notificationsTotal = database.getSentNotificationsCount();

    const text = `📊 **Статистика бота**

👥 **Пользователи**
  Всего: ${totalUsers}
  Активных за 24ч: ${analytics.dau}
  Активных за 7 дней: ${analytics.wau}
  Активных за 30 дней: ${analytics.mau}

📬 **Уведомления**
  За 24ч: ${notifications24h}
  Всего: ${notificationsTotal}`;
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error in stats command:', error);
    await ctx.reply(`❌ Ошибка при загрузке статистики: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
});

function formatFeatureLabel(name: string): string {
  if (name.startsWith('tz_')) return 'Выбор часового пояса';
  const labels: Record<string, string> = {
    start: '/start',
    daily: '/daily',
    settings: '/settings',
    ask: '/ask',
    help: '/help',
    id: '/id',
    daily_ai_forecast: 'AI Forecast (сегодня)',
    daily_ai_results: 'AI Results (сегодня)',
    ask_question: 'Вопросы к AI',
    toggle_asset: 'Настройка активов',
    settings_toggle_rss: 'RSS',
    settings_toggle_quiet_hours: 'Тихий режим',
    settings_news_source: 'Источник новостей',
    settings_news_impact: 'Фильтр важности',
    settings_timezone: 'Часовой пояс',
    source_forexfactory: 'Источник: ForexFactory',
    source_myfxbook: 'Источник: Myfxbook',
    source_both: 'Источник: оба',
    impact_both: 'Фильтр: Оба',
    impact_high: 'Фильтр: Красные',
    impact_medium: 'Фильтр: Жёлтые',
    settings_back: 'Назад в настройки',
    settings_close: 'Закрыть настройки',
  };
  return labels[name] ?? name;
}

// Handle /ask command (backward compatibility)
bot.command('ask', async (ctx) => {
  if (!ctx.chat) {
    return;
  }
  const text = ctx.message?.text?.replace('/ask', '').trim();
  
  if (!text) {
    // Enter question mode
    setUserState(ctx.chat.id, 'WAITING_FOR_QUESTION');
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
  setUserState(ctx.chat.id, 'WAITING_FOR_QUESTION');
  await ctx.answerCallbackQuery();
  await ctx.reply('Слушаю, задавай вопрос...');
});

// Helper function to process questions
async function processQuestion(ctx: any, question: string) {
  const userId = ctx.from?.id;
  if (userId) {
    database.logUserEvent(userId, 'message', 'ask_question');
  }
  try {
    await ctx.reply('🧠 Анализирую ваш вопрос...');
    
    // Optionally get current market context (today's events) to provide better answers
    let context: string | undefined;
    try {
      if (!userId) {
        if (ctx.chat) deleteUserState(ctx.chat.id);
        await ctx.reply('❌ Не удалось определить пользователя.').catch(() => {});
        return;
      }
      const events = await aggregateCoreEvents(forexFactoryService, myfxbookService, userId, false);
      if (events.length > 0) {
        const userTz = database.getTimezone(userId);
        const eventsForContext = events
          .slice(0, 5)
          .map(e => {
            const time24 = formatTime24(e, userTz);
            const title = stripRedundantCountryPrefix(e.currency, e.title);
            return `${time24} - [${e.currency}] ${title}${e.forecast && e.forecast !== '—' ? ` (Прогноз: ${e.forecast})` : ''}`;
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
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[Bot] processQuestion error:', errMsg, error);
    const isRateLimit =
      /429|rate limit|tokens per day|TPD|rate_limit_exceeded/i.test(errMsg);
    await ctx.reply(
      isRateLimit
        ? '⚠️ Исчерпан дневной лимит запросов к AI (Groq). Попробуйте завтра или обновите тариф: console.groq.com'
        : '❌ Ошибка при обработке вопроса. Попробуйте позже.'
    );
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

// Helper to build settings message text (single source of truth for settings summary)
function buildSettingsMessage(userId: number): string {
  const monitoredAssets = database.getMonitoredAssets(userId);
  const isQuietHoursEnabled = database.isQuietHoursEnabled(userId);
  const newsSource = database.getNewsSource(userId);
  const sourceName = newsSource === 'ForexFactory' ? 'ForexFactory' : newsSource === 'Myfxbook' ? 'Myfxbook' : 'Оба источника';
  const impactFilter = database.getNewsImpactFilter(userId);
  const impactName = impactFilter === 'high_only' ? 'Красные' : impactFilter === 'medium_only' ? 'Жёлтые' : 'Оба';
  return `⚙️ **Настройки**

**Отслеживаемые активы:** ${monitoredAssets.map(a => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ') || 'Нет'}
**Тихий режим:** ${isQuietHoursEnabled ? '✅ Включен (23:00-08:00)' : '❌ Выключен'}
**Источник новостей:** ${sourceName}
**Фильтр важности:** ${impactName}
**Часовой пояс:** ${getTimezoneDisplayName(database.getTimezone(userId))}

Нажмите на кнопку, чтобы изменить настройку:`;
}

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

  // Add News Impact filter button (red / yellow / both)
  const impactFilter = database.getNewsImpactFilter(userId);
  const impactText = impactFilter === 'high_only' ? '🔴 Красные' : 
                     impactFilter === 'medium_only' ? '🟡 Жёлтые' : 
                     '🔴🟡 Оба';
  keyboard.row({ text: `📌 Фильтр важности: ${impactText}`, callback_data: 'settings_news_impact' });

  // Add Timezone selection button
  const userTz = database.getTimezone(userId);
  const tzLabel = getTimezoneDisplayName(userTz);
  keyboard.row({ text: `🕐 Часовой пояс: ${tzLabel}`, callback_data: 'settings_timezone' });
  
  // Add "Close" button at the bottom
  keyboard.row({ text: '✅ Готово', callback_data: 'settings_close' });
  
  return keyboard;
}

// Handle /settings command
bot.command('settings', async (ctx) => {
  try {
    // Reset state if user was in question mode
    if (ctx.chat) {
      deleteUserState(ctx.chat.id);
    }
    
    if (!ctx.from) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя');
      return;
    }
    
    const userId = ctx.from.id;
    const keyboard = buildSettingsKeyboard(userId);
    const message = buildSettingsMessage(userId);
    
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
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
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
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
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
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
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

// Handle News Impact filter button – show submenu (Оба, Красные, Жёлтые)
bot.callbackQuery('settings_news_impact', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    const userId = ctx.from.id;
    const currentFilter = database.getNewsImpactFilter(userId);
    const keyboard = new InlineKeyboard();
    keyboard.row({ text: currentFilter === 'both' ? '✅ 🔴🟡 Оба' : '🔴🟡 Оба', callback_data: 'impact_both' });
    keyboard.row({ text: currentFilter === 'high_only' ? '✅ 🔴 Красные' : '🔴 Красные', callback_data: 'impact_high' });
    keyboard.row({ text: currentFilter === 'medium_only' ? '✅ 🟡 Жёлтые' : '🟡 Жёлтые', callback_data: 'impact_medium' });
    keyboard.row({ text: '◀️ Назад', callback_data: 'settings_back' });
    await ctx.editMessageText(
      '📌 **Фильтр важности новостей**\n\nПоказывать только события выбранной важности (для обоих источников — ForexFactory и Myfxbook).\n\n🔴 **Красные** — высокий impact\n🟡 **Жёлтые** — средний impact\n🔴🟡 **Оба** — красные и жёлтые',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error showing news impact menu:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при открытии меню', show_alert: false });
  }
});

// Handle Timezone selection button – show sub-menu
bot.callbackQuery('settings_timezone', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    const userId = ctx.from.id;
    const currentTz = database.getTimezone(userId);
    const keyboard = new InlineKeyboard();
    POPULAR_TIMEZONES.forEach((t, i) => {
      const isCurrent = currentTz === t.iana;
      keyboard.row({
        text: isCurrent ? `✅ ${t.label}` : t.label,
        callback_data: timezoneToCallbackData(i)
      });
    });
    keyboard.row({ text: '✏️ Ввести вручную', callback_data: 'tz_manual' });
    keyboard.row({ text: '◀️ Назад', callback_data: 'settings_back' });
    await ctx.editMessageText(
      '🕐 **Часовой пояс**\n\nВыберите город или нажмите «Ввести вручную» и отправьте название города (Москва, Киев) или IANA (Europe/Moscow).\n\nТихий режим (23:00–08:00) считается в выбранном поясе.',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error showing timezone menu:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при открытии меню', show_alert: false });
  }
});

// Handle "Enter timezone manually" – set state and ask for input (must be before generic tz_*)
bot.callbackQuery('tz_manual', async (ctx) => {
  try {
    if (!ctx.from || !ctx.chat) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка', show_alert: false });
      return;
    }
    setUserState(ctx.chat.id, 'WAITING_TIMEZONE');
    await ctx.editMessageText('✏️ Введите название города (например: Москва, Киев) или IANA (например: Europe/Moscow):');
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error starting manual timezone input:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка', show_alert: false });
  }
});

// Handle timezone selection from list (tz_0, tz_1, ...)
bot.callbackQuery(/^tz_\d+$/, async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    const userId = ctx.from.id;
    const index = parseInt(ctx.callbackQuery.data.replace(/^tz_/, ''), 10);
    const item = POPULAR_TIMEZONES[index];
    if (!item) {
      await ctx.answerCallbackQuery({ text: '❌ Неизвестный часовой пояс', show_alert: true });
      return;
    }
    const iana = item.iana;
    database.setTimezone(userId, iana);
    const label = getTimezoneDisplayName(iana);
    await ctx.answerCallbackQuery({ text: `Часовой пояс: ${label}`, show_alert: false });
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error setting timezone:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при сохранении', show_alert: false });
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
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Error handling source selection:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при обновлении', show_alert: false });
  }
});

// Handle impact filter selection (impact_both, impact_high, impact_medium)
bot.callbackQuery(/^impact_(both|high|medium)$/, async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    const userId = ctx.from.id;
    const impact = ctx.match[1];
    const filterValue: 'high_only' | 'medium_only' | 'both' =
      impact === 'high' ? 'high_only' : impact === 'medium' ? 'medium_only' : 'both';
    const impactName = filterValue === 'high_only' ? 'Красные' : filterValue === 'medium_only' ? 'Жёлтые' : 'Оба';
    database.setNewsImpactFilter(userId, filterValue);
    await ctx.answerCallbackQuery({ text: `Фильтр важности: ${impactName}`, show_alert: false });
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Error handling impact filter selection:', error);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при обновлении', show_alert: false });
  }
});

// Handle back button from news source / impact / timezone menu
bot.callbackQuery('settings_back', async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: не удалось определить пользователя', show_alert: false });
      return;
    }
    const userId = ctx.from.id;
    const keyboard = buildSettingsKeyboard(userId);
    await ctx.editMessageText(buildSettingsMessage(userId), {
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
📅 \`/tomorrow\` - События на завтра
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
  const state = getUserState(chatId);

  // If it's a command, reset state and let command handlers process it
  if (ctx.message.text?.startsWith('/')) {
    if (state === 'WAITING_FOR_QUESTION' || state === 'WAITING_TIMEZONE') {
      deleteUserState(chatId);
    }
    return;
  }

  // Handle manual timezone input
  if (state === 'WAITING_TIMEZONE') {
    const userId = ctx.from?.id;
    if (!userId) return;
    const iana = resolveTimezoneInput(ctx.message.text ?? '');
    deleteUserState(chatId);
    if (iana) {
      database.setTimezone(userId, iana);
      const label = getTimezoneDisplayName(iana);
      const keyboard = buildSettingsKeyboard(userId);
      const message = `✅ Часовой пояс сохранён: **${label}**\n\n${buildSettingsMessage(userId)}`;
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await ctx.reply('❌ Не удалось определить часовой пояс. Введите город (Москва, Киев) или IANA (Europe/Moscow).');
    }
    return;
  }
  
  // Only process if user is in WAITING_FOR_QUESTION state
  if (state === 'WAITING_FOR_QUESTION') {
    const question = ctx.message.text?.trim();
    if (question) {
      deleteUserState(chatId); // Reset state
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

// Ensure errors are logged for diagnostics (even when reducing verbose logs)
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] unhandledRejection:', reason, promise);
});


