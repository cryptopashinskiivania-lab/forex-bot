/**
 * MyFxBook calendar via RSS feed (replaces Playwright scraping).
 * Same API as MyfxbookService for backwards compatibility.
 */
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { CalendarEvent } from '../types/calendar';
import { database } from '../db/database';
import { DataQualityService } from './DataQualityService';
import { isPlaceholderActual } from '../utils/calendarValue';

dayjs.extend(utc);
dayjs.extend(timezone);

const RSS_FEED_URL = 'https://www.myfxbook.com/rss/forex-economic-calendar-events';
const DEFAULT_TZ = 'Europe/Kyiv';
const MYFXBOOK_TZ = 'GMT';
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/** Country slug (from RSS link path) to currency code */
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  'united-states': 'USD',
  'euro-area': 'EUR',
  'eurozone': 'EUR',
  'united-kingdom': 'GBP',
  'japan': 'JPY',
  'australia': 'AUD',
  'new-zealand': 'NZD',
  'canada': 'CAD',
  'switzerland': 'CHF',
  'china': 'CNY',
  'germany': 'EUR',
  'france': 'EUR',
  'italy': 'EUR',
  'spain': 'EUR',
  'netherlands': 'EUR',
  'turkey': 'TRY',
  'south-africa': 'ZAR',
  'brazil': 'BRL',
  'mexico': 'MXN',
  'india': 'INR',
  'south-korea': 'KRW',
  'hong-kong': 'HKD',
  'singapore': 'SGD',
  'russia': 'RUB',
  'poland': 'PLN',
  'sweden': 'SEK',
  'norway': 'NOK',
  'czech-republic': 'CZK',
  'hungary': 'HUF',
  'romania': 'RON',
  'indonesia': 'IDR',
  'malaysia': 'MYR',
  'philippines': 'PHP',
  'thailand': 'THB',
  'vietnam': 'VND',
  'egypt': 'EGP',
  'nigeria': 'NGN',
  'argentina': 'ARS',
  'chile': 'CLP',
  'colombia': 'COP',
  'peru': 'PEN',
  'israel': 'ILS',
  'saudi-arabia': 'SAR',
  'uae': 'AED',
  'ukraine': 'UAH',
  'greece': 'EUR',
  'portugal': 'EUR',
  'ireland': 'EUR',
  'austria': 'EUR',
  'belgium': 'EUR',
  'finland': 'EUR',
  'albania': 'ALL',
  'angola': 'AOA',
  'bolivia': 'BOB',
  'brunei': 'BND',
  'cape-verde': 'CVE',
  'ecuador': 'ECD',
  'kyrgyzstan': 'KGS',
  'libya': 'LYD',
  'macau': 'MOP',
  'mauritius': 'MUR',
  'mongolia': 'MNT',
  'panama': 'PAB',
  'serbia': 'RSD',
  'sri-lanka': 'LKR',
  'taiwan': 'TWD',
  'uruguay': 'UYU',
  'venezuela': 'VES',
  'malawi': 'MWK',
  'kazakhstan': 'KZT',
  'croatia': 'EUR',
  'bulgaria': 'BGN',
  'denmark': 'DKK',
  'iceland': 'ISK',
};

function getTimezone(): string {
  return process.env.TZ || process.env.TIMEZONE || DEFAULT_TZ;
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-' || t === '';
}

function normalizeValue(s: string): string {
  const t = (s || '').trim();
  if (!t || isPlaceholderActual(t)) return '—';
  return t;
}

/**
 * Extract currency from title ("USD - Event Name") or from link path (e.g. /united-kingdom/ -> GBP).
 */
function extractCurrency(title: string, link: string): string {
  const titleMatch = title.match(/^([A-Z]{3})\s*-\s*(.+)$/);
  if (titleMatch) return titleMatch[1].toUpperCase();

  try {
    const url = new URL(link);
    const path = url.pathname || '';
    const parts = path.split('/').filter(Boolean);
    for (const part of parts) {
      const slug = part.toLowerCase();
      const currency = COUNTRY_TO_CURRENCY[slug];
      if (currency) return currency;
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Parse impact from HTML: sprite-high-impact -> High, sprite-medium-impact -> Medium, else Low.
 */
function parseImpactFromHtml(html: string): 'High' | 'Medium' | 'Low' {
  const lower = html.toLowerCase();
  if (lower.includes('sprite-high-impact')) return 'High';
  if (lower.includes('sprite-medium-impact')) return 'Medium';
  return 'Low';
}

/**
 * Parse table row from description HTML: columns are Time left, Impact, Previous, Consensus, Actual.
 */
function parseTableFromDescription(description: string): {
  impact: 'High' | 'Medium' | 'Low';
  previous: string;
  consensus: string;
  actual: string;
} {
  const impact: 'High' | 'Medium' | 'Low' = parseImpactFromHtml(description);
  let previous = '—';
  let consensus = '—';
  let actual = '—';

  const $ = cheerio.load(description);
  const rows = $('table tr');
  if (rows.length >= 2) {
    const dataRow = rows.eq(1);
    const cells = dataRow.find('td');
    if (cells.length >= 5) {
      previous = normalizeValue(cells.eq(2).text());
      consensus = normalizeValue(cells.eq(3).text());
      const actualRaw = cells.eq(4).text().trim();
      actual = isPlaceholderActual(actualRaw) ? '—' : (actualRaw || '—');
    }
  }
  return { impact, previous, consensus, actual };
}

export class MyfxbookRssService {
  private parser: Parser;
  private dataQualityService: DataQualityService;
  private cache: { data: CalendarEvent[]; expires: number } | null = null;

  constructor() {
    this.parser = new Parser({
      customFields: {
        item: ['description', 'content:encoded', 'contentSnippet'],
      },
    });
    this.dataQualityService = new DataQualityService();
  }

  /**
   * Fetch and parse RSS feed. Returns all events (any date). Uses 3-minute cache.
   */
  private async fetchAllEvents(): Promise<CalendarEvent[]> {
    if (this.cache && this.cache.expires > Date.now()) {
      console.log(
        `[MyfxbookRssService] Using cached RSS data (expires in ${Math.round((this.cache.expires - Date.now()) / 1000)}s)`
      );
      return this.cache.data;
    }

    console.log('[MyfxbookRssService] Fetching RSS feed (MyFxBook calendar)...');
    const start = Date.now();

    try {
      const feed = await this.parser.parseURL(RSS_FEED_URL);

      if (!feed.items || feed.items.length === 0) {
        console.log('[MyfxbookRssService] No items in RSS feed');
        return [];
      }

      const events: CalendarEvent[] = [];

      for (const item of feed.items) {
        try {
          const title = (item.title || '').trim();
          const eventName = title.replace(/^[A-Z]{3}\s*-\s*/, '').trim() || title;
          if (!eventName) continue;

          const link = item.link || '';
          const currency = extractCurrency(title, link);
          if (!currency || currency.length > 3) continue;

          const pubDate = item.pubDate ? new Date(item.pubDate) : null;
          const timeISO = pubDate && pubDate.getTime() ? pubDate.toISOString() : undefined;
          const timeDisplay = pubDate
            ? dayjs(pubDate).tz(MYFXBOOK_TZ).format('HH:mm')
            : '—';

          const description = item.content || item.contentSnippet || item.description || '';
          const { impact, previous, consensus, actual } = parseTableFromDescription(description);

          if (impact !== 'High' && impact !== 'Medium') continue;

          const noActual = isEmpty(actual);
          const noForecast = isEmpty(consensus);
          const noPrevious = isEmpty(previous);
          const allEmpty = noActual && noForecast && noPrevious;
          const isSpeechMinutes = /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(eventName);
          if (allEmpty && !isSpeechMinutes) continue;

          events.push({
            title: eventName.replace(/\s+/g, ' '),
            currency,
            impact,
            time: timeDisplay,
            timeISO,
            forecast: consensus || '—',
            previous: previous || '—',
            actual: actual || '—',
            source: 'Myfxbook',
            isResult: !noActual,
          });
        } catch (itemErr) {
          console.warn('[MyfxbookRssService] Skip item parse error:', itemErr);
        }
      }

      console.log(`[MyfxbookRssService] Parsed ${events.length} High/Medium events from RSS in ${Date.now() - start}ms`);

      const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);

      if (issues.length > 0) {
        console.log(`[MyfxbookRssService] Data quality issues: ${issues.length}`);
        issues.forEach((issue) => {
          database.logDataIssue(
            issue.eventId,
            issue.source,
            issue.type,
            issue.message,
            issue.details
          );
        });
        issues.slice(0, 5).forEach((issue) => {
          console.log(`  - ${issue.type}: ${issue.message}`);
        });
      }

      this.cache = { data: valid, expires: Date.now() + CACHE_TTL_MS };
      console.log('[MyfxbookRssService] RSS calendar loaded successfully (using RSS feed, no browser)');
      return valid;
    } catch (error) {
      console.error('[MyfxbookRssService] Error fetching RSS:', error);
      return [];
    }
  }

  /**
   * Get today's events (raw, no timezone filter). Same API as MyfxbookService.
   */
  async getEventsForTodayRaw(): Promise<CalendarEvent[]> {
    const all = await this.fetchAllEvents();
    const todayStart = dayjs().tz(MYFXBOOK_TZ).startOf('day');
    const todayEnd = dayjs().tz(MYFXBOOK_TZ).endOf('day');
    return all.filter((e) => {
      if (!e.timeISO) return true;
      const t = dayjs(e.timeISO);
      return (t.isAfter(todayStart) || t.isSame(todayStart)) && (t.isBefore(todayEnd) || t.isSame(todayEnd));
    });
  }

  /**
   * Get today's events in user timezone. Same API as MyfxbookService.
   */
  async getEventsForToday(userTimezone?: string): Promise<CalendarEvent[]> {
    const all = await this.fetchAllEvents();
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const todayStart = nowLocal.startOf('day');
    const todayEnd = nowLocal.endOf('day');

    const filtered = all.filter((event) => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(todayStart) && eventDate.isBefore(todayEnd);
    });

    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = all.length - filtered.length;
      if (filteredOut > 0) {
        console.log(`[MyfxbookRssService] Today (${tz}): ${filtered.length} events, ${filteredOut} filtered out`);
      }
    }
    return filtered;
  }

  /**
   * Get tomorrow's events in user timezone. Same API as MyfxbookService.
   */
  async getEventsForTomorrow(userTimezone?: string): Promise<CalendarEvent[]> {
    const all = await this.fetchAllEvents();
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const tomorrowStart = nowLocal.add(1, 'day').startOf('day');
    const tomorrowEnd = nowLocal.add(1, 'day').endOf('day');

    const filtered = all.filter((event) => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(tomorrowStart) && eventDate.isBefore(tomorrowEnd);
    });

    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = all.length - filtered.length;
      if (filteredOut > 0) {
        console.log(`[MyfxbookRssService] Tomorrow (${tz}): ${filtered.length} events, ${filteredOut} filtered out`);
      }
    }
    return filtered;
  }

  /**
   * No-op for API compatibility (no browser to close).
   */
  async close(): Promise<void> {
    // RSS service has no persistent resources
  }
}
