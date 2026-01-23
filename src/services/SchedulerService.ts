import * as cron from 'node-cron';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { toZonedTime } from 'date-fns-tz';
import { addMinutes, parseISO, format } from 'date-fns';
import { CalendarService, CalendarEvent } from './CalendarService';
import { MyfxbookService } from './MyfxbookService';
import { AnalysisService, AnalysisResult } from './AnalysisService';
import { RssService, RssNewsItem } from './RssService';
import { env } from '../config/env';
import { database } from '../db/database';
import { getVolatility } from '../data/volatility';

const KYIV_TIMEZONE = 'Europe/Kyiv';

const CURRENCY_FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  NZD: '🇳🇿',
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

/**
 * Generate deduplication key based on time and currency
 * Used to detect duplicate events from different sources
 */
function deduplicationKey(event: CalendarEvent): string {
  // Use time (rounded to nearest 5 minutes) + currency for deduplication
  // This allows us to catch events that are the same but from different sources
  let timeKey = event.timeISO || event.time;
  
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      // Round to nearest 5 minutes
      const roundedMinutes = Math.floor(eventTime.getMinutes() / 5) * 5;
      const roundedTime = new Date(eventTime);
      roundedTime.setMinutes(roundedMinutes, 0, 0);
      timeKey = roundedTime.toISOString().substring(0, 16); // YYYY-MM-DDTHH:mm
    } catch {
      // If parsing fails, use original time
    }
  }
  
  return md5(`${timeKey}_${event.currency}`);
}

/**
 * Aggregate Core news sources (ForexFactory + Myfxbook) with deduplication
 */
async function aggregateCoreEvents(
  calendarService: CalendarService,
  myfxbookService: MyfxbookService
): Promise<CalendarEvent[]> {
  try {
    // Fetch from both Core sources in parallel
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      calendarService.getEventsForToday().catch(err => {
        console.error('[Scheduler] Error fetching ForexFactory events:', err);
        return [];
      }),
      myfxbookService.getEventsForToday().catch(err => {
        console.error('[Scheduler] Error fetching Myfxbook events:', err);
        return [];
      }),
    ]);

    console.log(`[Scheduler] ForexFactory: ${forexFactoryEvents.length} events, Myfxbook: ${myfxbookEvents.length} events`);

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
        // If we already have this event, prefer the one with more data (actual/forecast)
        const existing = deduplicationMap.get(key);
        if (existing) {
          const existingHasData = !isEmpty(existing.actual) || !isEmpty(existing.forecast);
          const currentHasData = !isEmpty(event.actual) || !isEmpty(event.forecast);
          
          // Prefer event with actual data, or higher impact, or ForexFactory (more reliable)
          if ((currentHasData && !existingHasData) ||
              (event.impact === 'High' && existing.impact !== 'High') ||
              (event.source === 'ForexFactory' && existing.source !== 'ForexFactory')) {
            deduplicationMap.set(key, event);
          }
        }
      }
    }
    
    const deduplicatedEvents = Array.from(deduplicationMap.values());
    console.log(`[Scheduler] After deduplication: ${deduplicatedEvents.length} unique events`);
    
    return deduplicatedEvents;
  } catch (error) {
    console.error('[Scheduler] Error aggregating Core events:', error);
    // Fallback to ForexFactory only if aggregation fails
    return calendarService.getEventsForToday().catch(() => []);
  }
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
 */
function isQuietHours(): boolean {
  if (!database.isQuietHoursEnabled()) {
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
 */
function shouldSendReminder(event: CalendarEvent): boolean {
  if (!event.timeISO) {
    // For events without valid time, send immediately (if not quiet hours)
    return !isQuietHours();
  }
  
  try {
    const eventTime = parseISO(event.timeISO);
    const now = new Date();
    
    // Calculate time difference in minutes
    const timeDiffMinutes = (eventTime.getTime() - now.getTime()) / (1000 * 60);
    
    // Send reminder if we're between 14 and 16 minutes before the event
    // This gives us a 2-minute window to catch the reminder
    const shouldSend = timeDiffMinutes >= 14 && timeDiffMinutes <= 16;
    
    return shouldSend && !isQuietHours();
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

  constructor() {
    this.calendarService = new CalendarService();
    this.myfxbookService = new MyfxbookService();
    this.analysisService = new AnalysisService();
    this.rssService = new RssService();
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
    const adminChatId = env.ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;

    if (!adminChatId) {
      console.warn('[Scheduler] No Admin Chat ID set, notifications disabled');
      console.warn('[Scheduler] Set ADMIN_CHAT_ID in .env to enable automatic notifications');
      return;
    }

    console.log('Starting SchedulerService with Kyiv timezone support...');
    console.log(`[Scheduler] Quiet hours: ${database.isQuietHoursEnabled() ? 'enabled (23:00-08:00 Kyiv)' : 'disabled'}`);

    // Schedule daily news at 08:00 Kyiv time
    // Convert 08:00 Kyiv to UTC cron expression
    // Note: node-cron doesn't support timezones directly, so we'll use a workaround
    // We'll check the time in the cron job itself
    cron.schedule('0 * * * *', async () => {
      const now = new Date();
      const kyivTime = toZonedTime(now, KYIV_TIMEZONE);
      const hour = kyivTime.getHours();
      const minute = kyivTime.getMinutes();
      
      // Check if it's 08:00 Kyiv time
      if (hour === 8 && minute === 0) {
        console.log('[Scheduler] Running daily news at 08:00 Kyiv time...');
        try {
          // Aggregate Core sources (ForexFactory + Myfxbook)
          const events = await aggregateCoreEvents(this.calendarService, this.myfxbookService);
          
          if (events.length === 0) {
            await bot.api.sendMessage(adminChatId, '📅 Сегодня нет событий с высоким/средним влиянием.');
            return;
          }

          // Format events list
          const lines = events.map((e, i) => {
            const n = i + 1;
            const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
            const time24 = formatTime24(e);
            return `${n}. ${impactEmoji} [${e.currency}] ${e.title}\n   🕐 ${time24}`;
          });
          const eventsText = `📅 События за сегодня:\n\n${lines.join('\n\n')}`;
          
          await bot.api.sendMessage(adminChatId, eventsText);
          
          // Get AI analysis
          try {
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
            
            const analysis = await this.analysisService.analyzeDailySchedule(eventsForAnalysis);
            await bot.api.sendMessage(adminChatId, `📊 Детальный анализ дня:\n\n${analysis}`, { parse_mode: 'Markdown' });
          } catch (analysisError) {
            console.error('[Scheduler] Error generating daily analysis:', analysisError);
          }
        } catch (error) {
          console.error('[Scheduler] Error in daily news:', error);
        }
      }
    });

    // Check for events and RSS every minute
    cron.schedule('* * * * *', async () => {
      console.log('[Scheduler] Running scheduled check...');

      try {
        // Check if RSS is enabled before fetching (External sources)
        const isRssEnabled = database.isRssEnabled();
        
        // Core sources (ForexFactory + Myfxbook) - always fetch
        // External sources (RSS) - only if enabled
        const [events, rssItems] = await Promise.all([
          aggregateCoreEvents(this.calendarService, this.myfxbookService),
          isRssEnabled ? this.rssService.getLatestNews() : Promise.resolve([]),
        ]);

        const toProcess: Array<
          | { type: 'calendar'; event: CalendarEvent; id: string; time: string; isReminder?: boolean }
          | { type: 'rss'; item: RssNewsItem; id: string; time: string }
        > = [];

        for (const event of events) {
          // Use timeISO if available (parsed time), otherwise use raw time string
          const time = event.timeISO || event.time;
          const id = itemId(event.title, time);
          
          // Check for reminder (15 minutes before event)
          if (event.timeISO && shouldSendReminder(event)) {
            const reminderId = `reminder_${id}`;
            if (!database.hasSent(reminderId)) {
              toProcess.push({ type: 'calendar', event, id: reminderId, time, isReminder: true });
            }
          }
          
          // Check for result (if actual is available and not sent yet)
          // Results are important, so send them even during quiet hours
          if (event.isResult && !database.hasSent(id)) {
            toProcess.push({ type: 'calendar', event, id, time, isReminder: false });
          }
          
          // For events without valid timeISO (All Day, Tentative), process them immediately
          // if they are high/medium impact and not in quiet hours
          if (!event.timeISO && !database.hasSent(id) && !isQuietHours()) {
            toProcess.push({ type: 'calendar', event, id, time, isReminder: false });
          }
        }

        for (const item of rssItems) {
          const time = item.pubDate?.toISOString() ?? item.title;
          const id = itemId(item.title, time);
          if (database.hasSent(id)) continue;
          
          // Only process RSS if not in quiet hours
          if (!isQuietHours()) {
            toProcess.push({ type: 'rss', item, id, time });
          }
        }

        console.log(`[Scheduler] ${toProcess.length} new items to process`);

        for (const entry of toProcess) {
          try {
            if (entry.type === 'calendar') {
              const { event, id, isReminder } = entry;
              
              // Check quiet hours for reminders (results are always sent)
              if (isReminder && isQuietHours()) {
                console.log(`[Scheduler] Skipping reminder during quiet hours: ${event.title}`);
                continue;
              }
              
              const text = `Event: ${event.title}, Currency: ${event.currency}, Actual: ${event.actual}, Forecast: ${event.forecast}, Previous: ${event.previous}`;
              const result = await this.analysisService.analyzeNews(text, event.source || 'ForexFactory');
              const emoji = scoreEmoji(result.score);
              const header = isReminder ? '⏰ НАПОМИНАНИЕ (за 15 мин)' : this.getHeader(false, event.isResult);
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
              await bot.api.sendMessage(adminChatId, msg, { parse_mode: undefined });
              database.markAsSent(id);
              console.log(`[Scheduler] Calendar notification sent: ${event.title}${isReminder ? ' (reminder)' : ''}`);
            } else {
              const { item, id } = entry;
              const text = `Breaking News: ${item.title}. Summary: ${item.summary}`;
              const result = await this.analysisService.analyzeNews(text, item.source);
              const emoji = scoreEmoji(result.score);
              const header = this.getHeader(true, false);
              
              // Try to extract currency from title/summary for better flag display
              const monitoredAssets = database.getMonitoredAssets();
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
              await bot.api.sendMessage(adminChatId, full, { parse_mode: undefined });
              database.markAsSent(id);
              console.log(`[Scheduler] RSS notification sent: ${item.title}`);
            }
          } catch (err) {
            console.error(`[Scheduler] Error processing item:`, err);
          }
        }
      } catch (err) {
        console.error('[Scheduler] Error in scheduled check:', err);
      }
    });

    console.log('SchedulerService started successfully');
  }
}
