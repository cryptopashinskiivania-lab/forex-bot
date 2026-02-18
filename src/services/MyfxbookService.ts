/**
 * MyFxBook calendar via Playwright HTML scraping.
 * URL with startDate/endDate allows events for any date (including tomorrow).
 * filter[]=1 (High), filter[]=2 (Medium).
 */
import { chromium, Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { fromZonedTime } from 'date-fns-tz';
import { CalendarEvent } from '../types/calendar';
import { database } from '../db/database';
import { DataQualityService } from './DataQualityService';
import { isPlaceholderActual } from '../utils/calendarValue';
import { runWithBrowserLock } from '../utils/browserFetchLock';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const DEFAULT_TZ = 'Europe/Kyiv';
const MYFXBOOK_TZ = 'GMT';
// 10 min cache — снижает частоту запусков browser и нагрузку на CPU/RAM
const CACHE_TTL_MS = 10 * 60 * 1000;
const BROWSER_IDLE_CLOSE_MS = 30 * 60 * 1000; // закрыть browser если не использовался 30 мин
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // проверять каждые 5 мин

const CALENDAR_BASE = 'https://www.myfxbook.com/forex-economic-calendar';

function getCalendarUrl(startDate: string, endDate: string): string {
  const params = new URLSearchParams();
  params.append('filter[]', '1');
  params.append('filter[]', '2');
  params.set('startDate', startDate);
  params.set('endDate', endDate);
  return `${CALENDAR_BASE}?${params.toString()}`;
}

function getTimezone(): string {
  return process.env.TZ || process.env.TIMEZONE || DEFAULT_TZ;
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-' || t === '';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isBrowserClosedOrTimeout(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('target page, context or browser has been closed')) return true;
    if (msg.includes('browser has been closed')) return true;
    if (error.name === 'TimeoutError') return true;
    if (msg.includes('timeout') && msg.includes('exceeded')) return true;
  }
  return false;
}

function isSpecialTimeString(timeStr: string): boolean {
  const t = timeStr.trim().toLowerCase();
  return (
    !t ||
    t === 'tentative' ||
    t === 'all day' ||
    t.includes('day') ||
    t === '—' ||
    t === '-'
  );
}

function parseTimeToISO(raw: string, baseDate: dayjs.Dayjs): string | undefined {
  const t = raw.trim();

  if (isSpecialTimeString(t)) {
    return undefined;
  }

  try {
    if (t.includes(',')) {
      const formats = ['MMM D, HH:mm', 'MMM DD, HH:mm', 'MMM D, H:mm', 'MMM DD, H:mm'];
      for (const fmt of formats) {
        try {
          const parsed = dayjs.tz(t, fmt, MYFXBOOK_TZ);
          if (parsed.isValid()) {
            const year = parsed.year();
            const month = String(parsed.month() + 1).padStart(2, '0');
            const day = String(parsed.date()).padStart(2, '0');
            const hours = String(parsed.hour()).padStart(2, '0');
            const minutes = String(parsed.minute()).padStart(2, '0');
            const seconds = String(parsed.second()).padStart(2, '0');
            const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            const utcDate = fromZonedTime(dateString, MYFXBOOK_TZ);
            const isoString = utcDate.toISOString();
            if (utcDate.getFullYear() >= 2000 && utcDate.getFullYear() <= 2100) {
              return isoString;
            }
          }
        } catch {
          continue;
        }
      }
    } else {
      const dateStr = baseDate.format('YYYY-MM-DD');
      const combined = `${dateStr} ${t}`;
      const formats = ['YYYY-MM-DD HH:mm', 'YYYY-MM-DD H:mm'];
      for (const fmt of formats) {
        try {
          const parsed = dayjs.tz(combined, fmt, MYFXBOOK_TZ);
          if (parsed.isValid()) {
            const year = parsed.year();
            const month = String(parsed.month() + 1).padStart(2, '0');
            const day = String(parsed.date()).padStart(2, '0');
            const hours = String(parsed.hour()).padStart(2, '0');
            const minutes = String(parsed.minute()).padStart(2, '0');
            const seconds = String(parsed.second()).padStart(2, '0');
            const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            const utcDate = fromZonedTime(dateString, MYFXBOOK_TZ);
            const isoString = utcDate.toISOString();
            if (utcDate.getFullYear() >= 2000 && utcDate.getFullYear() <= 2100) {
              return isoString;
            }
          }
        } catch {
          continue;
        }
      }
    }

    console.warn(`[MyfxbookService] Could not parse time: "${t}"`);
    return undefined;
  } catch (error) {
    console.warn(
      '[MyfxbookService] Error parsing time "' + t + '":',
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

function parseImpact(impactText: string): 'High' | 'Medium' | 'Low' {
  const impact = impactText.trim().toLowerCase();
  if (impact.includes('high')) return 'High';
  if (impact.includes('medium')) return 'Medium';
  return 'Low';
}

/** Оптимизированные аргументы запуска Chromium: меньше RAM/CPU, без GPU и лишних фоновых сервисов */
const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--metrics-recording-only',
  '--mute-audio',
];

export class MyfxbookService {
  /** Переиспользование одного экземпляра браузера между запросами — экономия 150–200 MB RAM на запрос */
  private static browserInstance: Browser | null = null;
  private static browserPromise: Promise<Browser> | null = null;
  private static lastUsed = 0;
  private static idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  private dataQualityService: DataQualityService;
  private cache = new Map<string, { data: CalendarEvent[]; expires: number }>();

  constructor() {
    this.dataQualityService = new DataQualityService();
  }

  /** Единая точка получения браузера: переиспользует существующий или создаёт с оптимизированными флагами */
  private static async getBrowser(): Promise<Browser> {
    try {
      if (MyfxbookService.browserInstance && MyfxbookService.browserInstance.isConnected()) {
        MyfxbookService.lastUsed = Date.now();
        return MyfxbookService.browserInstance;
      }
    } catch {
      MyfxbookService.browserInstance = null;
    }

    if (MyfxbookService.browserPromise) {
      MyfxbookService.lastUsed = Date.now();
      return MyfxbookService.browserPromise;
    }

    MyfxbookService.browserPromise = chromium
      .launch({
        headless: true,
        args: CHROMIUM_LAUNCH_ARGS,
      })
      .then((browser) => {
        MyfxbookService.browserInstance = browser;
        MyfxbookService.browserPromise = null;
        MyfxbookService.lastUsed = Date.now();
        MyfxbookService.ensureIdleCheckInterval();
        return browser;
      });

    return MyfxbookService.browserPromise;
  }

  /** Периодическая проверка: закрыть браузер если не использовался 30 минут */
  private static ensureIdleCheckInterval(): void {
    if (MyfxbookService.idleCheckInterval !== null) return;
    MyfxbookService.idleCheckInterval = setInterval(() => {
      if (
        MyfxbookService.lastUsed > 0 &&
        Date.now() - MyfxbookService.lastUsed > BROWSER_IDLE_CLOSE_MS &&
        MyfxbookService.browserInstance
      ) {
        const b = MyfxbookService.browserInstance;
        MyfxbookService.browserInstance = null;
        b.close().catch(() => {});
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  private async fetchHTML(url: string): Promise<string> {
    let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
    let page: Page | null = null;
    try {
      const browser = await MyfxbookService.getBrowser();
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        timezoneId: 'GMT',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });
      page = await context.newPage();
      // Блокировка image/css/font/media — экономия трафика и 40–60% RAM на странице
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      try {
        await Promise.race([
          page.waitForSelector('table', { timeout: 10000 }),
          page.waitForSelector('.calendar-row', { timeout: 10000 }),
        ]);
      } catch {
        // продолжаем с тем HTML, что есть
      }
      await delay(1000);
      const html = await page.content();
      return html;
    } catch (error) {
      if (isBrowserClosedOrTimeout(error)) {
        MyfxbookService.browserInstance = null;
        return '';
      }
      console.error('[MyfxbookService] Error fetching HTML:', error);
      throw new Error(
        'Failed to fetch Myfxbook calendar: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          /* ignore */
        }
        page = null;
      }
      if (context) {
        try {
          await context.close();
        } catch {
          /* ignore */
        }
        context = null;
      }
    }
  }

  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
    const startTime = Date.now();
    const startMem = process.memoryUsage().heapUsed;

    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    let html: string;
    try {
      html = await runWithBrowserLock(() => this.fetchHTML(url));
    } catch (error) {
      if (isBrowserClosedOrTimeout(error)) {
        MyfxbookService.browserInstance = null;
        return [];
      }
      throw error;
    }
    if (!html) {
      return [];
    }

    try {
      const $ = cheerio.load(html);
      const events: CalendarEvent[] = [];

      const baseDate = url.includes('startDate=')
        ? dayjs(
            (url.match(/startDate=(\d{4}-\d{2}-\d{2})/) || [])[1] ||
              dayjs().format('YYYY-MM-DD')
          ).tz(MYFXBOOK_TZ)
        : dayjs().tz(MYFXBOOK_TZ);

      $('table tr').each((_, rowEl) => {
        try {
          const $row = $(rowEl);
          const $cells = $row.find('td');

          if ($cells.length < 9) {
            return;
          }

          const timeText = $cells.eq(0).text().trim() || '';
          const currency = $cells.eq(3).text().trim() || '';
          const title = $cells.eq(4).text().trim() || '';
          const impactText = $cells.eq(5).text().trim() || '';
          const previous = $cells.eq(6).text().trim() || '—';
          const forecast = $cells.eq(7).text().trim() || '—';
          const actualRaw = $cells.eq(8).text().trim() || '—';
          const actual = isPlaceholderActual(actualRaw) ? '—' : actualRaw || '—';

          if (!currency || !title || currency.length > 3) {
            return;
          }
          if (currency === 'Currency' || title.includes('Date') || title.includes('Event')) {
            return;
          }

          const impact = parseImpact(impactText);
          if (impact !== 'High' && impact !== 'Medium') return;

          const noActual = isEmpty(actual);
          const noForecast = isEmpty(forecast);
          const noPrevious = isEmpty(previous);
          const allEmpty = noActual && noForecast && noPrevious;
          const isSpeechMinutesStatement = /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(
            title
          );
          if (allEmpty && !isSpeechMinutesStatement) return;

          const timeISO = parseTimeToISO(timeText, baseDate);
          const isResult = !noActual;

          events.push({
            title: title.replace(/\s+/g, ' '),
            currency,
            impact,
            time: timeText || '—',
            timeISO,
            forecast: forecast || '—',
            previous: previous || '—',
            actual: actual || '—',
            source: 'Myfxbook',
            isResult,
          });
        } catch (rowError) {
          console.warn('[MyfxbookService] Error parsing row:', rowError);
        }
      });

      if (events.length === 0) {
        console.warn(
          '[MyfxbookService] No events found with table tr; selectors may have changed'
        );
      }

      const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);

      if (issues.length > 0) {
        issues.forEach((issue) => {
          database.logDataIssue(
            issue.eventId,
            issue.source,
            issue.type,
            issue.message,
            issue.details
          );
        });
      }

      this.cache.set(url, {
        data: valid,
        expires: Date.now() + CACHE_TTL_MS,
      });

      const endMem = process.memoryUsage().heapUsed;
      const duration = Date.now() - startTime;
      const memDelta = ((endMem - startMem) / 1024 / 1024).toFixed(2);
      console.log(
        `[MyfxbookService] Parsed ${valid.length} events in ${duration}ms, RAM delta: ${memDelta}MB`
      );
      return valid;
    } catch (error) {
      console.error('[MyfxbookService] Error parsing events:', error);
      return [];
    }
  }

  /**
   * Get today's events from the calendar (raw, no timezone filter).
   * Used by scheduler shared calendar.
   */
  async getEventsForTodayRaw(): Promise<CalendarEvent[]> {
    const today = dayjs().tz(MYFXBOOK_TZ).format('YYYY-MM-DD');
    const url = getCalendarUrl(today, today);
    return this.fetchEvents(url);
  }

  /**
   * Get today's events in user timezone.
   */
  async getEventsForToday(userTimezone?: string): Promise<CalendarEvent[]> {
    const today = dayjs().tz(MYFXBOOK_TZ).format('YYYY-MM-DD');
    const url = getCalendarUrl(today, today);
    const events = await this.fetchEvents(url);
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const todayStart = nowLocal.startOf('day');
    const todayEnd = nowLocal.endOf('day');

    const filtered = events.filter((event) => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(todayStart) && eventDate.isBefore(todayEnd);
    });
    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = events.length - filtered.length;
      if (filteredOut > 0) {
        console.log(
          '[MyfxbookService] Today (' +
            tz +
            '): ' +
            filtered.length +
            ' events, ' +
            filteredOut +
            ' filtered out'
        );
      }
    }
    return filtered;
  }

  /**
   * Get tomorrow's events in user timezone.
   */
  async getEventsForTomorrow(userTimezone?: string): Promise<CalendarEvent[]> {
    const tomorrow = dayjs().tz(MYFXBOOK_TZ).add(1, 'day').format('YYYY-MM-DD');
    const url = getCalendarUrl(tomorrow, tomorrow);
    const events = await this.fetchEvents(url);
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const tomorrowStart = nowLocal.add(1, 'day').startOf('day');
    const tomorrowEnd = nowLocal.add(1, 'day').endOf('day');

    const filtered = events.filter((event) => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(tomorrowStart) && eventDate.isBefore(tomorrowEnd);
    });
    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = events.length - filtered.length;
      if (filteredOut > 0) {
        console.log(
          '[MyfxbookService] Tomorrow (' +
            tz +
            '): ' +
            filtered.length +
            ' events, ' +
            filteredOut +
            ' filtered out'
        );
      }
    }
    return filtered;
  }

  /**
   * Close the shared browser instance. Call on shutdown.
   */
  async close(): Promise<void> {
    if (MyfxbookService.idleCheckInterval !== null) {
      clearInterval(MyfxbookService.idleCheckInterval);
      MyfxbookService.idleCheckInterval = null;
    }
    if (MyfxbookService.browserInstance) {
      try {
        await MyfxbookService.browserInstance.close();
      } catch (err) {
        console.warn('[MyfxbookService] Error closing browser:', err);
      }
      MyfxbookService.browserInstance = null;
    }
  }
}
