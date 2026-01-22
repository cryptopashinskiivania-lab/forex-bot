import * as cron from 'node-cron';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { CalendarService, CalendarEvent } from './CalendarService';
import { AnalysisService, AnalysisResult } from './AnalysisService';
import { RssService, RssNewsItem } from './RssService';
import { env } from '../config/env';
import { database } from '../db/database';

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

export class SchedulerService {
  private calendarService: CalendarService;
  private analysisService: AnalysisService;
  private rssService: RssService;

  constructor() {
    this.calendarService = new CalendarService();
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

    console.log('Starting SchedulerService - checking every minute...');

    cron.schedule('* * * * *', async () => {
      console.log('[Scheduler] Running scheduled check...');

      try {
        // Check if RSS is enabled before fetching
        const isRssEnabled = database.isRssEnabled();
        
        const [events, rssItems] = await Promise.all([
          this.calendarService.getEventsForToday(),
          isRssEnabled ? this.rssService.getLatestNews() : Promise.resolve([]),
        ]);

        const toProcess: Array<
          | { type: 'calendar'; event: CalendarEvent; id: string; time: string }
          | { type: 'rss'; item: RssNewsItem; id: string; time: string }
        > = [];

        for (const event of events) {
          // Use timeISO if available (parsed time), otherwise use raw time string
          // This handles cases like "All Day" or "Tentative" where timeISO is undefined
          const time = event.timeISO || event.time;
          const id = itemId(event.title, time);
          if (database.hasSent(id)) continue;
          
          // For events without valid timeISO (All Day, Tentative), process them immediately
          // if they are high/medium impact (they're already filtered by CalendarService)
          toProcess.push({ type: 'calendar', event, id, time });
        }

        for (const item of rssItems) {
          const time = item.pubDate?.toISOString() ?? item.title;
          const id = itemId(item.title, time);
          if (database.hasSent(id)) continue;
          toProcess.push({ type: 'rss', item, id, time });
        }

        console.log(`[Scheduler] ${toProcess.length} new items to process`);

        for (const entry of toProcess) {
          try {
            if (entry.type === 'calendar') {
              const { event, id } = entry;
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
              await bot.api.sendMessage(adminChatId, msg, { parse_mode: undefined });
              database.markAsSent(id);
              console.log(`[Scheduler] Calendar notification sent: ${event.title}`);
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
