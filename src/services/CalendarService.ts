import { chromium, Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { fromZonedTime } from 'date-fns-tz';
import { database } from '../db/database';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const DEFAULT_TZ = 'Europe/Kyiv';
const FF_TZ = 'America/New_York';

export interface CalendarEvent {
  title: string;
  currency: string;
  impact: 'High' | 'Medium' | 'Low';
  time: string;
  timeISO?: string;
  forecast: string;
  previous: string;
  actual: string;
  source?: string;
  isResult: boolean;
}

const CALENDAR_URL_TODAY = 'https://www.forexfactory.com/calendar?day=today';
const CALENDAR_URL_TOMORROW = 'https://www.forexfactory.com/calendar?day=tomorrow';

function getTimezone(): string {
  return process.env.TZ || process.env.TIMEZONE || DEFAULT_TZ;
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
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
  
  // Check for special time strings first
  if (isSpecialTimeString(t)) {
    return undefined;
  }
  
  // Try to parse the time string
  try {
    // Get base date components in NY timezone to know which day we're parsing for
    const baseDateNY = dayjs().tz(FF_TZ);
    const dateStr = baseDate.format('YYYY-MM-DD');
    const combined = `${dateStr} ${t}`;
    
    // Try multiple time formats
    const formats: string[] = [
      'YYYY-MM-DD h:mma',
      'YYYY-MM-DD h:mm a',
      'YYYY-MM-DD h:mm A',
      'YYYY-MM-DD h:mm',
      'YYYY-MM-DD HH:mm',
    ];
    
    for (const fmt of formats) {
      try {
        // Parse time WITHOUT timezone (as "naive" time)
        // This gives us the time components exactly as they appear on ForexFactory
        const parsed = dayjs(combined, fmt);
        if (parsed.isValid()) {
          // Extract components from the parsed time
          // These represent the time AS SHOWN on ForexFactory (which is in America/New_York)
          const year = parsed.year();
          const month = String(parsed.month() + 1).padStart(2, '0');
          const day = String(parsed.date()).padStart(2, '0');
          const hours = String(parsed.hour()).padStart(2, '0');
          const minutes = String(parsed.minute()).padStart(2, '0');
          const seconds = '00';
          
          // This time string represents America/New_York local time
          const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
          
          // CRITICAL: Convert from America/New_York local time to UTC
          // fromZonedTime interprets the date string as being in FF_TZ timezone
          // and returns the corresponding UTC Date object
          const utcDate = fromZonedTime(dateString, FF_TZ);
          
          // Convert to ISO string (which is in UTC)
          const isoString = utcDate.toISOString();
          
          // Validate the ISO string is reasonable (not 1970 or far future)
          if (utcDate.getFullYear() >= 2000 && utcDate.getFullYear() <= 2100) {
            return isoString;
          }
        }
      } catch (formatError) {
        // Try next format
        continue;
      }
    }
    
    // If all formats failed, log warning but don't crash
    console.warn(`[CalendarService] Could not parse time: "${t}"`);
    return undefined;
  } catch (error) {
    console.warn(`[CalendarService] Error parsing time "${t}":`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

export class CalendarService {
  private browser: Browser | null = null;
  private browserLock: Promise<Browser> | null = null;
  
  // Cache for calendar events (5 minutes TTL)
  private cache = new Map<string, { data: CalendarEvent[], expires: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

  /**
   * Initialize browser instance with anti-detection settings
   */
  private async getBrowser(): Promise<Browser> {
    // If browser is already being launched, wait for it
    if (this.browserLock) {
      console.log('[CalendarService] Waiting for browser to launch...');
      return this.browserLock;
    }
    
    if (!this.browser || !this.browser.isConnected()) {
      console.log('[CalendarService] Launching Chromium browser...');
      
      // Set lock while launching
      this.browserLock = chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      
      try {
        this.browser = await this.browserLock;
        console.log('[CalendarService] Browser launched successfully');
      } finally {
        this.browserLock = null;
      }
    }
    return this.browser;
  }

  /**
   * Fetch HTML using Playwright to bypass Cloudflare
   */
  private async fetchHTML(url: string): Promise<string> {
    const browser = await this.getBrowser();
    const page: Page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    try {
      console.log(`[CalendarService] Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      // Wait for the calendar table to load
      console.log('[CalendarService] Waiting for calendar data...');
      await page.waitForSelector('table.calendar__table', { timeout: 10000 });
      
      const html = await page.content();
      console.log('[CalendarService] Successfully fetched HTML');
      
      return html;
    } finally {
      await page.close();
    }
  }

  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
    // Check cache first
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      console.log(`[CalendarService] Using cached data for ${url} (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.data;
    }

    console.log(`[CalendarService] Cache miss or expired for ${url}, fetching fresh data...`);
    const html = await this.fetchHTML(url);

    const $ = cheerio.load(html);
    const events: CalendarEvent[] = [];
    const baseDate = url.includes('tomorrow')
      ? dayjs().tz(FF_TZ).add(1, 'day')
      : dayjs().tz(FF_TZ);

    const allRows = $('table.calendar__table tr');
    console.log(`[CalendarService] Found ${allRows.length} total rows in calendar table`);
    
    let rowsProcessed = 0;
    let eventsFound = 0;
    let eventsFiltered = 0;

    allRows.each((_, rowEl) => {
      rowsProcessed++;
      const $row = $(rowEl);
      const $cells = $row.find('td');

      if ($cells.length < 5) return;

      const currency = $row.find('.calendar__currency').text().trim();
      const title = $row
        .find('.calendar__event-title')
        .text()
        .trim()
        .replace(/\s+/g, ' ');
      const time = $row.find('.calendar__time').text().trim() || '—';
      const forecast = $row.find('.calendar__forecast').text().trim() || '—';
      const previous = $row.find('.calendar__previous').text().trim() || '—';
      const actual = $row.find('.calendar__actual').text().trim() || '—';

      if (!title || currency === 'Currency' || currency === 'All') return;

      eventsFound++;

      let impact: 'High' | 'Medium' | 'Low' = 'Low';
      const $impactSpan = $row.find('.calendar__impact span');
      const impactClass = $impactSpan.attr('class')?.toLowerCase() ?? '';

      if (impactClass.includes('icon--ff-impact-red')) {
        impact = 'High';
      } else if (
        impactClass.includes('icon--ff-impact-orange') ||
        impactClass.includes('icon--ff-impact-ora')
      ) {
        impact = 'Medium';
      }

      // Get monitored assets from database
      const monitoredAssets = database.getMonitoredAssets();
      const ALLOWED_CURRENCIES = new Set(monitoredAssets);
      
      const allowed =
        ALLOWED_CURRENCIES.has(currency) &&
        (impact === 'High' || impact === 'Medium');
      if (!allowed) {
        eventsFiltered++;
        if (eventsFiltered <= 5) { // Log first 5 filtered events
          console.log(`[CalendarService] Filtered: "${title}" [${currency}] ${impact} - reason: ${!ALLOWED_CURRENCIES.has(currency) ? 'currency not monitored' : 'low impact'}`);
        }
        return;
      }

      const noActual = isEmpty(actual);
      const noForecast = isEmpty(forecast);
      const noPrevious = isEmpty(previous);
      const allEmpty = noActual && noForecast && noPrevious;
      const isSpeechMinutesStatement =
        /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(title);
      if (allEmpty && !isSpeechMinutesStatement) return;

      const timeISO = parseTimeToISO(time, baseDate);
      const isResult = !noActual;

      events.push({
        title,
        currency,
        impact,
        time,
        timeISO,
        forecast: forecast || '—',
        previous: previous || '—',
        actual: actual || '—',
        source: 'ForexFactory',
        isResult,
      });
    });

    console.log(`[CalendarService] Parsing complete:`);
    console.log(`  - Rows processed: ${rowsProcessed}`);
    console.log(`  - Events found: ${eventsFound}`);
    console.log(`  - Events filtered: ${eventsFiltered}`);
    console.log(`  - Events passed: ${events.length}`);

    // Store in cache
    this.cache.set(url, {
      data: events,
      expires: Date.now() + this.CACHE_TTL
    });
    console.log(`[CalendarService] Cached ${events.length} events for ${url}`);

    return events;
  }

  async getEventsForToday(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TODAY);
  }

  async getEventsForTomorrow(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TOMORROW);
  }

  /**
   * Close the browser instance (cleanup)
   */
  async close(): Promise<void> {
    if (this.browser) {
      console.log('[CalendarService] Closing browser...');
      await this.browser.close();
      this.browser = null;
    }
  }
}
