import * as cron from 'node-cron';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { toZonedTime } from 'date-fns-tz';
import { addMinutes, parseISO, format } from 'date-fns';
import { CalendarService, CalendarEvent } from './CalendarService';
import { MyfxbookService } from './MyfxbookService';
import { AnalysisService, AnalysisResult } from './AnalysisService';
import { RssService, RssNewsItem } from './RssService';
import { DataQualityService } from './DataQualityService';
import { env } from '../config/env';
import { database } from '../db/database';
import { getVolatility } from '../data/volatility';
import { aggregateCoreEvents } from '../utils/eventAggregation';

const KYIV_TIMEZONE = 'Europe/Kyiv';

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

/**
 * Format time to 24-hour format (HH:mm)
 * If timeISO is available, use it; otherwise try to parse the time string
 */
function formatTime24(event: CalendarEvent): string {
  // If we have ISO time, format it directly
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const kyivTime = toZonedTime(eventTime, KYIV_TIMEZONE);
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
 * Check if current time in Kyiv timezone is within quiet hours (23:00 - 08:00)
 * Now checks per-user setting
 */
function isQuietHours(userId: number): boolean {
  if (!database.isQuietHoursEnabled(userId)) {
    return false;
  }
  
  const now = new Date();
  const kyivTime = toZonedTime(now, KYIV_TIMEZONE);
  const hour = kyivTime.getHours();
  
  // Quiet hours: 23:00 - 08:00 (23:00 to 23:59, and 00:00 to 07:59)
  return hour >= 23 || hour < 8;
}

/**
 * Check if we should send notification for an event (15 minutes before event time)
 * Now checks per-user quiet hours
 */
function shouldSendReminder(event: CalendarEvent, userId: number): boolean {
  if (!event.timeISO) {
    // For events without valid time, send immediately (if not quiet hours)
    return !isQuietHours(userId);
  }
  
  try {
    const eventTime = parseISO(event.timeISO);
    const now = new Date();
    
    // Calculate time difference in minutes
    const timeDiffMinutes = (eventTime.getTime() - now.getTime()) / (1000 * 60);
    
    // Send reminder if we're between 14 and 16 minutes before the event
    // This gives us a 2-minute window to catch the reminder
    const shouldSend = timeDiffMinutes >= 14 && timeDiffMinutes <= 16;
    
    return shouldSend && !isQuietHours(userId);
  } catch (error) {
    console.error('[Scheduler] Error checking reminder time:', error);
    return false;
  }
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

  private getHeader(
    isRss: boolean,
    isResult: boolean
  ): string {
    if (isRss) return '🔥 СРОЧНО';
    if (isResult) return '⚡ РЕЗУЛЬТАТ';
    return '⏰ НАПОМИНАНИЕ';
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
    
    // Add volatility information if available (whitelist approach: only if found in VOLATILITY_RULES)
    const volatility = getVolatility(title, currency);
    if (volatility) {
      msg += `📉 Average Volatility: ${volatility}\n`;
    }
    // If volatility is null, no line is added (whitelist: only show if in rules)
    
    msg += `📡 Источник: ${source}\n`;
    msg += `🎯 Влияние: ${score}/10 ${emoji}\n`;
    msg += `💚 Настроение: ${sentimentEmoji} ${result.sentiment === 'Pos' ? 'Позитивное' : result.sentiment === 'Neg' ? 'Негативное' : 'Нейтральное'} ${trendArrow}\n`;
    if (!isEmpty(actual) || !isEmpty(forecast)) {
      const parts: string[] = [];
      if (!isEmpty(actual)) parts.push(`Факт: ${actual}`);
      if (!isEmpty(forecast)) parts.push(`Прогноз: ${forecast}`);
      msg += `📊 ${parts.join(' | ')}\n`;
    }
    msg += `💡 Суть: ${result.summary}\n`;
    msg += `🧠 Логика: ${result.reasoning}`;
    return msg;
  }

  start(bot: Bot): void {
    console.log('Starting SchedulerService with Kyiv timezone support...');
    console.log('[Scheduler] Multi-user mode: notifications will be sent to all registered users based on their settings');

    // Schedule daily news at 08:00 Kyiv time
    // Convert 08:00 Kyiv to UTC cron expression
    // Note: node-cron doesn't support timezones directly, so we'll use a workaround
    // We'll check the time in the cron job itself
    const dailyNewsTask = cron.schedule('0 * * * *', async () => {
      const now = new Date();
      const kyivTime = toZonedTime(now, KYIV_TIMEZONE);
      const hour = kyivTime.getHours();
      const minute = kyivTime.getMinutes();
      
      // Check if it's 08:00 Kyiv time
      if (hour === 8 && minute === 0) {
        console.log('[Scheduler] Running daily news at 08:00 Kyiv time...');
        try {
          // Get all registered users
          const users = database.getUsers();
          
          if (users.length === 0) {
            console.log('[Scheduler] No registered users found');
            return;
          }

          // Send daily digest to each user based on their monitored assets and news source
          await Promise.allSettled(
            users.map(async (user) => {
              try {
                // Get events for this user (based on their news source preference)
                const events = await aggregateCoreEvents(this.calendarService, this.myfxbookService, user.user_id, false);
                
                const monitoredAssets = database.getMonitoredAssets(user.user_id);
                
                // Filter events by user's monitored assets
                const userEventsRaw = events.filter(e => monitoredAssets.includes(e.currency));
                
                // IMPORTANT: Apply data quality filter before delivery
                const { deliver: userEvents, skipped } = this.dataQualityService.filterForDelivery(
                  userEventsRaw,
                  { mode: 'general', nowUtc: new Date() }
                );
                
                if (skipped.length > 0) {
                  console.log(`[Scheduler] Daily digest: ${skipped.length} events skipped for user ${user.user_id}`);
                }
                
                if (userEvents.length === 0) {
                  await bot.api.sendMessage(user.user_id, '📅 Сегодня нет событий с высоким/средним влиянием для ваших активов.')
                    .catch(err => console.error(`[Scheduler] Error sending to user ${user.user_id}:`, err));
                  return;
                }
                
                // Format events list
                const lines = userEvents.map((e, i) => {
                  const n = i + 1;
                  const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
                  const time24 = formatTime24(e);
                  return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}`;
                });
                const eventsText = `📅 События за сегодня:\n\n${lines.join('\n\n')}`;
                
                await bot.api.sendMessage(user.user_id, eventsText);
                
                // Get AI analysis
                try {
                  const eventsForAnalysis = userEvents.map(e => {
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
                  
                  const analysis = await this.analysisService.analyzeDailySchedule(eventsForAnalysis);
                  await bot.api.sendMessage(user.user_id, `📊 Детальный анализ дня:\n\n${analysis}`, { parse_mode: 'Markdown' });
                } catch (analysisError) {
                  console.error(`[Scheduler] Error generating daily analysis for user ${user.user_id}:`, analysisError);
                }
              } catch (error) {
                console.error(`[Scheduler] Error sending daily news to user ${user.user_id}:`, error);
              }
            })
          );
        } catch (error) {
          console.error('[Scheduler] Error in daily news:', error);
        }
      }
    });
    this.cronTasks.push(dailyNewsTask);

    // Check for events and RSS every 3 minutes (optimized from every minute)
    const minuteCheckTask = cron.schedule('*/3 * * * *', async () => {
      console.log('[Scheduler] Running scheduled check (every 3 minutes)...');

      try {
        // Get all registered users
        const users = database.getUsers();
        
        if (users.length === 0) {
          console.log('[Scheduler] No registered users found');
          return;
        }

        // Process calendar events for each user (with their news source preference)
        await Promise.allSettled(
          users.map(async (user) => {
            try {
              const userId = user.user_id;
              const monitoredAssets = database.getMonitoredAssets(userId);
              const isRssEnabled = database.isRssEnabled(userId);
              
              // Get events for this user (based on their news source preference)
              const events = await aggregateCoreEvents(this.calendarService, this.myfxbookService, userId, false);
              
              // Filter events by user's monitored assets
              const userEventsRaw = events.filter(e => monitoredAssets.includes(e.currency));
              
              // IMPORTANT: Apply data quality filter before processing
              const { deliver: userEvents } = this.dataQualityService.filterForDelivery(
                userEventsRaw,
                { mode: 'general', nowUtc: new Date() }
              );
              
              // Process calendar events
              for (const event of userEvents) {
                const time = event.timeISO || event.time;
                const id = itemId(event.title, time);
                
                // Check for reminder (15 minutes before event)
                // Note: filterForDelivery already filtered out past events, 
                // but shouldSendReminder checks the specific 15-minute window
                if (event.timeISO && shouldSendReminder(event, userId)) {
                  const reminderId = `reminder_${userId}_${id}`;
                  if (!database.hasSent(reminderId)) {
                    try {
                      const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                      const result = await this.analysisService.analyzeNews(text, event.source || 'ForexFactory');
                      const emoji = scoreEmoji(result.score);
                      const header = '⏰ НАПОМИНАНИЕ (за 15 мин)';
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
                      database.markAsSent(reminderId);
                      console.log(`[Scheduler] Reminder sent to user ${userId}: ${event.title}`);
                    } catch (err) {
                      console.error(`[Scheduler] Error sending reminder to user ${userId}:`, err);
                    }
                  }
                }
                
                // Check for result (if actual is available and not sent yet)
                // Results are important, so send them even during quiet hours
                if (event.isResult) {
                  const resultId = `result_${userId}_${id}`;
                  if (!database.hasSent(resultId)) {
                    try {
                      const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                      const result = await this.analysisService.analyzeNews(text, event.source || 'ForexFactory');
                      const emoji = scoreEmoji(result.score);
                      const header = this.getHeader(false, event.isResult);
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
                      database.markAsSent(resultId);
                      console.log(`[Scheduler] Result sent to user ${userId}: ${event.title}`);
                    } catch (err) {
                      console.error(`[Scheduler] Error sending result to user ${userId}:`, err);
                    }
                  }
                }
                
                // For events without valid timeISO (All Day, Tentative), process them immediately
                // if they are high/medium impact and not in quiet hours
                if (!event.timeISO && !isQuietHours(userId)) {
                  const eventId = `event_${userId}_${id}`;
                  if (!database.hasSent(eventId)) {
                    try {
                      const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
                      const result = await this.analysisService.analyzeNews(text, event.source || 'ForexFactory');
                      const emoji = scoreEmoji(result.score);
                      const header = this.getHeader(false, false);
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
                      console.log(`[Scheduler] Event sent to user ${userId}: ${event.title}`);
                    } catch (err) {
                      console.error(`[Scheduler] Error sending event to user ${userId}:`, err);
                    }
                  }
                }
              }
              
              // Process RSS if enabled for this user
              if (isRssEnabled && !isQuietHours(userId)) {
                const rssItems = await this.rssService.getLatestNews().catch(() => []);
                
                for (const item of rssItems) {
                  const time = item.pubDate?.toISOString() ?? item.title;
                  const rssId = `rss_${userId}_${itemId(item.title, time)}`;
                  
                  if (!database.hasSent(rssId)) {
                    try {
                      const text = `Breaking News: ${item.title}. Summary: ${item.summary}`;
                      const result = await this.analysisService.analyzeNews(text, item.source);
                      const emoji = scoreEmoji(result.score);
                      const header = this.getHeader(true, false);
                      
                      // Try to extract currency from title/summary for better flag display
                      let detectedCurrency = '';
                      let flag = '📰';
                      
                      for (const asset of monitoredAssets) {
                        if (item.title.toUpperCase().includes(asset) || item.summary.toUpperCase().includes(asset)) {
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
                      console.log(`[Scheduler] RSS sent to user ${userId}: ${item.title}`);
                    } catch (err) {
                      console.error(`[Scheduler] Error sending RSS to user ${userId}:`, err);
                    }
                  }
                }
              }
            } catch (error) {
              console.error(`[Scheduler] Error processing notifications for user ${user.user_id}:`, error);
            }
          })
        );
      } catch (err) {
        console.error('[Scheduler] Error in scheduled check:', err);
      }
    });
    this.cronTasks.push(minuteCheckTask);

    console.log('SchedulerService started successfully');
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
