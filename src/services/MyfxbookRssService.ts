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
 * Parse RSS pubDate to ISO string in UTC. MyFxBook feed is in GMT.
 * If the string has no timezone (e.g. "2026-02-18T07:00:00" or "Wed, 18 Feb 2026 07:00:00"),
 * JavaScript would interpret it as server local time; we treat it as GMT so calendar dates are consistent.
 */
function parsePubDateToUtcIso(pubDateStr: string | undefined): string | undefined {
  if (!pubDateStr || typeof pubDateStr !== 'string') return undefined;
  const s = pubDateStr.trim();
  if (!s) return undefined;
  const hasTimezone = /[Zz]|[+-]\d{2}:?\d{2}$|\s(GMT|UTC|EST|EDT|CET|CEST|PST|PDT|[A-Z]{3,4})$/i.test(s);
  let dateStr = s;
  if (!hasTimezone) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/i.test(s)) {
      dateStr = s + 'Z';
    } else if (/^[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?$/i.test(s)) {
      dateStr = s + ' GMT';
    }
  }
  try {
    const d = new Date(dateStr);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  } catch {
    return undefined;
  }
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
 * Parse "Time left" from first column: "12345 seconds", "-40618 seconds", or "0 seconds".
 * MyFxBook RSS uses this as seconds from feed reference time to the event; eventTime = referenceTime + timeLeftSeconds.
 */
function parseTimeLeftSeconds(description: string): number | null {
  const $ = cheerio.load(description);
  const rows = $('table tr');
  if (rows.length < 2) return null;
  const dataRow = rows.eq(1);
  const cells = dataRow.find('td');
  if (cells.length < 1) return null;
  const raw = cells.eq(0).text().trim();
  const match = raw.match(/^(-?\d+)\s*seconds?$/i);
  if (!match) return null;
  const sec = parseInt(match[1], 10);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * Parse table row from description HTML: columns are Time left, Impact, Previous, Consensus, Actual.
 */
function parseTableFromDescription(description: string): {
  impact: 'High' | 'Medium' | 'Low';
  previous: string;
  consensus: string;
  actual: string;
  timeLeftSeconds: number | null;
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
  const timeLeftSeconds = parseTimeLeftSeconds(description);
  return { impact, previous, consensus, actual, timeLeftSeconds };
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
      const fetchTimeMs = Date.now();

      for (const item of feed.items) {
        try {
          const title = (item.title || '').trim();
          const eventName = title.replace(/^[A-Z]{3}\s*-\s*/, '').trim() || title;
          if (!eventName) continue;

          const link = item.link || '';
          const currency = extractCurrency(title, link);
          if (!currency || currency.length > 3) continue;

          const description = item.content || item.contentSnippet || item.description || '';
          const { impact, previous, consensus, actual, timeLeftSeconds } = parseTableFromDescription(description);

          // Время события: приоритет у "Time left" (секунды от момента генерации фида), иначе pubDate.
          // eventTime = fetchTime + timeLeftSeconds даёт правильную дату/время события (совпадает с календарём на сайте).
          let timeISO: string | undefined;
          if (timeLeftSeconds !== null && Number.isFinite(timeLeftSeconds)) {
            const eventMs = fetchTimeMs + timeLeftSeconds * 1000;
            timeISO = new Date(eventMs).toISOString();
          } else {
            timeISO = parsePubDateToUtcIso(item.pubDate);
          }
          const timeDisplay = timeISO
            ? dayjs(timeISO).tz(MYFXBOOK_TZ).format('HH:mm')
            : '—';

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
   * Get events for shared calendar (raw: no user timezone filter).
   * Returns today + tomorrow in GMT so that getEventsForUserFromShared can show
   * "today" in any user TZ (e.g. user in Kyiv already has 19th while GMT is still 18th).
   */
  async getEventsForTodayRaw(): Promise<CalendarEvent[]> {
    const all = await this.fetchAllEvents();
    const now = dayjs().tz(MYFXBOOK_TZ);
    const todayStart = now.startOf('day');
    const tomorrowEnd = now.add(1, 'day').endOf('day');
    return all.filter((e) => {
      if (!e.timeISO) return true;
      const t = dayjs(e.timeISO);
      return (t.isAfter(todayStart) || t.isSame(todayStart)) && (t.isBefore(tomorrowEnd) || t.isSame(tomorrowEnd));
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
      return (eventDate.isSame(todayStart) || eventDate.isAfter(todayStart)) && (eventDate.isSame(todayEnd) || eventDate.isBefore(todayEnd));
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

    console.log(`[MyfxbookRssService] getEventsForTomorrow: tz=${tz}, range=${tomorrowStart.format('YYYY-MM-DD HH:mm')} to ${tomorrowEnd.format('YYYY-MM-DD HH:mm')}`);
    console.log(`[MyfxbookRssService] Total events before filter: ${all.length}`);

    let noTimeISO = 0;
    let outOfRange = 0;
    let passed = 0;
    const filtered = all.filter((event) => {
      if (!event.timeISO) {
        noTimeISO++;
        return false;
      }
      const eventDate = dayjs(event.timeISO).tz(tz);
      const isInRange = (eventDate.isSame(tomorrowStart) || eventDate.isAfter(tomorrowStart)) && (eventDate.isSame(tomorrowEnd) || eventDate.isBefore(tomorrowEnd));
      if (!isInRange) {
        outOfRange++;
        return false;
      }
      passed++;
      return true;
    });
    console.log(`[MyfxbookRssService] Filter results: passed=${passed}, noTimeISO=${noTimeISO}, outOfRange=${outOfRange}`);
    const sample = all.slice(0, 10).map(e => ({
      currency: e.currency,
      title: e.title.slice(0, 40),
      timeISO: e.timeISO,
      inRange: e.timeISO ? dayjs(e.timeISO).tz(tz).format('YYYY-MM-DD HH:mm') : 'NO_TIME'
    }));
    console.log('[MyfxbookRssService] First 10 events:', JSON.stringify(sample, null, 2));

    return filtered;
  }

  /**
   * No-op for API compatibility (no browser to close).
   */
  async close(): Promise<void> {
    // RSS service has no persistent resources
  }
}
