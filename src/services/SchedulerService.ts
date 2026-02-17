import * as cron from 'node-cron';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { toZonedTime } from 'date-fns-tz';
import { parseISO, format, subMinutes, addMinutes } from 'date-fns';
import { CalendarService, CalendarEvent } from './CalendarService';
import { MyfxbookService } from './MyfxbookService';
import { AnalysisService, AnalysisResult } from './AnalysisService';
import { RssService, RssNewsItem } from './RssService';
import { DataQualityService } from './DataQualityService';
import { env } from '../config/env';
import { database } from '../db/database';
import { fetchSharedCalendarToday, getEventsForUserFromShared } from '../utils/eventAggregation';
import { isPlaceholderActual } from '../utils/calendarValue';

const CURRENCY_FLAGS: Record<string, string> = {
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

function md5(str: string): string {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function itemId(title: string, time: string): string {
  return md5(title + time);
}

/** За сколько минут до события с временем отправлять напоминание */
const REMINDER_MINUTES_BEFORE = 15;
/** Через сколько минут после времени события отправлять результат (чтобы календарь успел обновиться) */
const RESULT_MINUTES_AFTER = 5;

function getSentimentEmoji(sentiment: 'Pos' | 'Neg' | 'Neutral'): string {
  if (sentiment === 'Pos') return '🟢';
  if (sentiment === 'Neg') return '🔴';
  return '⚪';
}

function getTrendArrow(reasoning: string, sentiment: 'Pos' | 'Neg' | 'Neutral'): string {
  // Analyze reasoning to determine trend direction
  const reasoningUpper = reasoning.toUpperCase();
  
  // Look for bullish indicators
  const bullishKeywords = ['РОСТ', 'ПОВЫШЕНИЕ', 'УСИЛЕНИЕ', 'ПОЗИТИВ', 'ВЫШЕ', 'УВЕЛИЧЕНИЕ', 'РАСТЕТ', 'РОСТЕТ'];
  // Look for bearish indicators
  const bearishKeywords = ['ПАДЕНИЕ', 'СНИЖЕНИЕ', 'ОСЛАБЛЕНИЕ', 'НЕГАТИВ', 'НИЖЕ', 'УМЕНЬШЕНИЕ', 'ПАДАЕТ'];
  
  const hasBullish = bullishKeywords.some(keyword => reasoningUpper.includes(keyword));
  const hasBearish = bearishKeywords.some(keyword => reasoningUpper.includes(keyword));
  
  // If sentiment is positive and has bullish keywords, or sentiment is negative and has bearish keywords
  if ((sentiment === 'Pos' && hasBullish) || (sentiment === 'Neg' && hasBearish)) {
    return sentiment === 'Pos' ? '📈' : '📉';
  }
  
  // Default based on sentiment
  if (sentiment === 'Pos') return '📈';
  if (sentiment === 'Neg') return '📉';
  return '➡️';
}

function scoreEmoji(score: number): string {
  if (score >= 8) return '🔴';
  if (score >= 5) return '🟡';
  return '⚪';
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
}

/** Don't show "Факт: PENDING" — treat placeholders as no data (safety net if event wasn't normalized at source). */
function hasRealActual(actual: string): boolean {
  return !isEmpty(actual) && !isPlaceholderActual(actual);
}

/**
 * Format event time to 24-hour (HH:mm) in the given timezone
 */
function formatTime24(event: CalendarEvent, timezone: string): string {
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const localTime = toZonedTime(eventTime, timezone);
      return format(localTime, 'HH:mm');
    } catch {
      // Fall through
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
 * Check if current time in user's timezone is within quiet hours (23:00 - 08:00)
 * Uses per-user timezone from settings (default Europe/Kyiv)
 */
function isQuietHours(userId: number): boolean {
  if (!database.isQuietHoursEnabled(userId)) {
    return false;
  }
  const userTz = database.getTimezone(userId);
  const now = new Date();
  const localTime = toZonedTime(now, userTz);
  const hour = localTime.getHours();
  return hour >= 23 || hour < 8;
}

export class SchedulerService {
  private calendarService: CalendarService;
  private myfxbookService: MyfxbookService;
  private analysisService: AnalysisService;
  private rssService: RssService;
  private dataQualityService: DataQualityService;
  private cronTasks: cron.ScheduledTask[] = [];

  constructor() {
    this.calendarService = new CalendarService();
    this.myfxbookService = new MyfxbookService();
    this.analysisService = new AnalysisService();
    this.rssService = new RssService();
    this.dataQualityService = new DataQualityService();
  }

  private getHeader(isRss: boolean): string {
    if (isRss) return '🔥 СРОЧНО';
    return '📅 СОБЫТИЕ';
  }

  private formatMessage(
    header: string,
    flag: string,
    currency: string,
    title: string,
    source: string,
    score: number,
    emoji: string,
    actual: string,
    forecast: string,
    result: AnalysisResult
  ): string {
    const sentimentEmoji = getSentimentEmoji(result.sentiment);
    const trendArrow = getTrendArrow(result.reasoning, result.sentiment);
    
    let msg = `${header} | ${flag} ${currency} | ${title}\n\n`;
    
    msg += `📡 Источник: ${source}\n`;
    msg += `🎯 Влияние: ${score}/10 ${emoji}\n`;
    msg += `💚 Настроение: ${sentimentEmoji} ${result.sentiment === 'Pos' ? 'Позитивное' : result.sentiment === 'Neg' ? 'Негативное' : 'Нейтральное'} ${trendArrow}\n`;
    if (hasRealActual(actual) || !isEmpty(forecast)) {
      const parts: string[] = [];
      if (hasRealActual(actual)) parts.push(`Факт: ${actual}`);
      if (!isEmpty(forecast)) parts.push(`Прогноз: ${forecast}`);
      msg += `📊 ${parts.join(' | ')}\n`;
    }
    msg += `💡 Суть: ${result.summary}\n`;
    msg += `🧠 Логика: ${result.reasoning}`;
    return msg;
  }

  /**
   * Run the notification check once (events without time, RSS).
   * Called by cron every 3 min and once on startup after delay.
   */
  private async runScheduledCheck(bot: Bot): Promise<void> {
    console.log('[Scheduler] Running scheduled check...');

    try {
      const users = database.getUsers();

      if (users.length === 0) {
        console.log('[Scheduler] No registered users found — no notifications will be sent');
        return;
      }

      console.log(`[Scheduler] Processing notifications for ${users.length} user(s)`);

      const shared = await fetchSharedCalendarToday(this.calendarService, this.myfxbookService);
      console.log(
        `[Scheduler] Shared calendar: ForexFactory=${shared.forexFactory.length} Myfxbook=${shared.myfxbook.length}`
      );

      const BATCH_SIZE = 40;
      const BATCH_DELAY_MS = 150;

      for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const chunk = users.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          chunk.map(async (user) => {
            try {
              const userId = user.user_id;
              const monitoredAssets = database.getMonitoredAssets(userId);
              const isRssEnabled = database.isRssEnabled(userId);

              const events = getEventsForUserFromShared(shared, userId);
              const userEventsRaw = events.filter((e) => monitoredAssets.includes(e.currency));
              const { deliver: userEvents } = this.dataQualityService.filterForDelivery(
                userEventsRaw,
                { mode: 'general', nowUtc: new Date() }
              );

              const eventsWithoutTime = userEvents.filter((e) => !e.timeISO);
              const quiet = isQuietHours(userId);

              let eventsSent = 0;
              let rssSent = 0;

              if (userEventsRaw.length === 0 || userEvents.length === 0) {
                console.log(
                  `[Scheduler] User ${userId}: ${events.length} total from calendar, ${userEventsRaw.length} for monitored assets, ${userEvents.length} after quality filter`
                );
              }

              for (const event of userEvents) {
                const time = event.timeISO || event.time;
                const id = itemId(event.title, time);
                const eventId = `event_${userId}_${id}`;
                const alreadySent = database.hasSent(eventId);

                if (!event.timeISO && !quiet && !alreadySent) {
                  try {
                    const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                    const result = await this.analysisService.analyzeNews(
                      text,
                      event.source || 'ForexFactory'
                    );
                    const emoji = scoreEmoji(result.score);
                    const header = this.getHeader(false);
                    const flag = CURRENCY_FLAGS[event.currency] ?? '📌';
                    const msg = this.formatMessage(
                      header,
                      flag,
                      event.currency,
                      event.title,
                      event.source || 'ForexFactory',
                      result.score,
                      emoji,
                      event.actual,
                      event.forecast,
                      result
                    );
                    await bot.api.sendMessage(userId, msg, { parse_mode: undefined });
                    database.markAsSent(eventId);
                    eventsSent++;
                    console.log(`[Scheduler] Event sent to user ${userId}: ${event.title}`);
                  } catch (err) {
                    console.error(`[Scheduler] Error sending event to user ${userId}:`, err);
                  }
                  continue;
                }

                if (event.timeISO && !quiet && !alreadySent) {
                  const eventTime = parseISO(event.timeISO);
                  const now = new Date();
                  const reminderFrom = subMinutes(eventTime, REMINDER_MINUTES_BEFORE);
                  if (now >= reminderFrom && now <= eventTime) {
                    try {
                      const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                      const result = await this.analysisService.analyzeNews(
                        text,
                        event.source || 'ForexFactory'
                      );
                      const emoji = scoreEmoji(result.score);
                      const header = this.getHeader(false);
                      const flag = CURRENCY_FLAGS[event.currency] ?? '📌';
                      const msg = this.formatMessage(
                        header,
                        flag,
                        event.currency,
                        event.title,
                        event.source || 'ForexFactory',
                        result.score,
                        emoji,
                        event.actual,
                        event.forecast,
                        result
                      );
                      await bot.api.sendMessage(userId, msg, { parse_mode: undefined });
                      database.markAsSent(eventId);
                      eventsSent++;
                      console.log(
                        `[Scheduler] Reminder sent to user ${userId}: ${event.title} (in ${REMINDER_MINUTES_BEFORE} min)`
                      );
                    } catch (err) {
                      console.error(`[Scheduler] Error sending reminder to user ${userId}:`, err);
                    }
                  }
                }

                if (event.timeISO && !quiet && hasRealActual(event.actual)) {
                  const resultId = `result_${userId}_${id}`;
                  if (!database.hasSent(resultId)) {
                    const eventTime = parseISO(event.timeISO);
                    const now = new Date();
                    const resultFrom = addMinutes(eventTime, RESULT_MINUTES_AFTER);
                    if (now >= resultFrom) {
                      try {
                        const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                        const analysisResult = await this.analysisService.analyzeNews(
                          text,
                          event.source || 'ForexFactory'
                        );
                        const emoji = scoreEmoji(analysisResult.score);
                        const header = '📊 РЕЗУЛЬТАТ';
                        const flag = CURRENCY_FLAGS[event.currency] ?? '📌';
                        const msg = this.formatMessage(
                          header,
                          flag,
                          event.currency,
                          event.title,
                          event.source || 'ForexFactory',
                          analysisResult.score,
                          emoji,
                          event.actual,
                          event.forecast,
                          analysisResult
                        );
                        await bot.api.sendMessage(userId, msg, { parse_mode: undefined });
                        database.markAsSent(resultId);
                        eventsSent++;
                        console.log(
                          `[Scheduler] Result sent to user ${userId}: ${event.title} (actual: ${event.actual})`
                        );
                      } catch (err) {
                        console.error(`[Scheduler] Error sending result to user ${userId}:`, err);
                      }
                    }
                  }
                }
              }

              if (isRssEnabled && !quiet) {
                const rssItems = await this.rssService.getLatestNews().catch(() => []);

                for (const item of rssItems) {
                  const time = item.pubDate?.toISOString() ?? item.title;
                  const rssId = `rss_${userId}_${itemId(item.title, time)}`;

                  if (!database.hasSent(rssId)) {
                    try {
                      const text = `Breaking News: ${item.title}. Summary: ${item.summary}`;
                      const result = await this.analysisService.analyzeNews(text, item.source);
                      const emoji = scoreEmoji(result.score);
                      const header = this.getHeader(true);

                      let detectedCurrency = '';
                      let flag = '📰';

                      for (const asset of monitoredAssets) {
                        if (
                          item.title.toUpperCase().includes(asset) ||
                          item.summary.toUpperCase().includes(asset)
                        ) {
                          detectedCurrency = asset;
                          flag = CURRENCY_FLAGS[asset] || '📰';
                          break;
                        }
                      }

                      const displayCurrency = detectedCurrency || item.source;
                      const msg = this.formatMessage(
                        header,
                        flag,
                        displayCurrency,
                        item.title,
                        item.source,
                        result.score,
                        emoji,
                        '',
                        '',
                        result
                      );
                      let full = msg;
                      if (item.link) full += `\n\n🔗 ${item.link}`;
                      await bot.api.sendMessage(userId, full, { parse_mode: undefined });
                      database.markAsSent(rssId);
                      rssSent++;
                      console.log(`[Scheduler] RSS sent to user ${userId}: ${item.title}`);
                    } catch (err) {
                      console.error(`[Scheduler] Error sending RSS to user ${userId}:`, err);
                    }
                  }
                }
              }

              const totalSent = eventsSent + rssSent;
              if (totalSent > 0) {
                console.log(
                  `[Scheduler] User ${userId}: events=${userEvents.length} sent: events=${eventsSent} rss=${rssSent}`
                );
              } else if (userEvents.length > 0 || isRssEnabled) {
                console.log(
                  `[Scheduler] User ${userId}: events=${userEvents.length} (without time: ${eventsWithoutTime.length}) quiet=${quiet} sent=0`
                );
              }
            } catch (error) {
              console.error(
                `[Scheduler] Error processing notifications for user ${user.user_id}:`,
                error
              );
            }
          })
        );
        if (i + BATCH_SIZE < users.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }
      console.log('[Scheduler] Scheduled check finished.');
    } catch (err) {
      console.error('[Scheduler] Error in scheduled check:', err);
    }
  }

  start(bot: Bot): void {
    console.log('Starting SchedulerService with per-user timezone support...');
    console.log('[Scheduler] Multi-user mode: notifications (events, RSS) will be sent to all registered users based on their settings');

    // Check for events and RSS every 3 minutes; use UTC for predictable behavior
    const minuteCheckTask = cron.schedule(
      '*/3 * * * *',
      () => this.runScheduledCheck(bot),
      { timezone: 'UTC', noOverlap: true }
    );
    this.cronTasks.push(minuteCheckTask);

    // Run check once shortly after start so we see logs and any issues immediately
    const startDelayMs = 15 * 1000;
    setTimeout(() => {
      console.log('[Scheduler] Running initial notification check (on startup)...');
      void this.runScheduledCheck(bot);
    }, startDelayMs);

    console.log('SchedulerService started successfully (notification check every 3 min and once after 15s)');
  }

  /**
   * Run a one-off diagnostic (no sends). Returns a text report for debugging notifications.
   */
  async runNotificationDiagnostics(): Promise<string> {
    const now = new Date();
    const lines: string[] = [];
    lines.push(`=== Диагностика оповещений ${now.toISOString().slice(0, 19)}Z ===`);
    const users = database.getUsers();
    if (users.length === 0) {
      lines.push('Пользователей: 0');
      return lines.join('\n');
    }
    lines.push(`Пользователей: ${users.length}`);
    for (const user of users) {
      const userId = user.user_id;
      let tz = '?';
      try {
        tz = database.getTimezone(userId);
      } catch (_) {}
      const localTime = (() => {
        try {
          return toZonedTime(now, tz);
        } catch (_) {
          return null;
        }
      })();
      const localStr = localTime
        ? `${localTime.getHours().toString().padStart(2, '0')}:${localTime.getMinutes().toString().padStart(2, '0')}`
        : '?';
      const quiet = isQuietHours(userId);
      lines.push(`\nUser ${userId}: tz=${tz} local=${localStr} тихий=${quiet}`);
    }
    try {
      const shared = await fetchSharedCalendarToday(this.calendarService, this.myfxbookService);
      lines.push(`\nКалендарь: FF=${shared.forexFactory.length} Myfxbook=${shared.myfxbook.length}`);
      for (const user of users) {
        const userId = user.user_id;
        const events = getEventsForUserFromShared(shared, userId);
        const monitored = database.getMonitoredAssets(userId);
        const raw = events.filter((e) => monitored.includes(e.currency));
        const { deliver: userEvents } = this.dataQualityService.filterForDelivery(raw, { mode: 'general', nowUtc: new Date() });
        const eventsWithoutTime = userEvents.filter((e) => !e.timeISO);
        lines.push(`\nUser ${userId}: событий после фильтров=${userEvents.length}, без времени (к отправке)=${eventsWithoutTime.length}`);
      }
    } catch (err) {
      lines.push(`\nОшибка при получении календаря: ${err instanceof Error ? err.message : String(err)}`);
    }
    lines.push('\n=== Конец диагностики ===');
    return lines.join('\n');
  }

  /**
   * Stop all cron tasks and cleanup resources
   */
  async stop(): Promise<void> {
    console.log('[Scheduler] Stopping all cron tasks...');
    for (const task of this.cronTasks) {
      task.stop();
    }
    this.cronTasks = [];
    console.log('[Scheduler] All cron tasks stopped');
    
    // Close both browsers (ForexFactory and Myfxbook now use Playwright)
    await this.calendarService.close();
    await this.myfxbookService.close();
    console.log('[Scheduler] Services cleaned up');
  }
}
