import { chromium, Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { fromZonedTime } from 'date-fns-tz';
import { database } from '../db/database';
import { DataQualityService } from './DataQualityService';
import { sendCriticalDataAlert } from '../utils/adminAlerts';
import { isPlaceholderActual } from '../utils/calendarValue';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const DEFAULT_TZ = 'Europe/Kyiv';
const FF_TZ = 'America/New_York'; // ForexFactory shows times in EST/EDT timezone

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

/**
 * Parse time string to ISO format
 * @param raw - Raw time string from ForexFactory (e.g. "3:30pm", "15:30")
 * @param baseDate - Base date for the event
 * @param sourceTimezone - Timezone of the source (detected from ForexFactory)
 */
function parseTimeToISO(raw: string, baseDate: dayjs.Dayjs, sourceTimezone: string): string | undefined {
  const t = raw.trim();
  
  // Check for special time strings first
  if (isSpecialTimeString(t)) {
    return undefined;
  }
  
  // Try to parse the time string
  try {
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
          // These represent the time AS SHOWN on ForexFactory
          const year = parsed.year();
          const month = String(parsed.month() + 1).padStart(2, '0');
          const day = String(parsed.date()).padStart(2, '0');
          const hours = String(parsed.hour()).padStart(2, '0');
          const minutes = String(parsed.minute()).padStart(2, '0');
          const seconds = '00';
          
          // This time string represents the time in sourceTimezone
          const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
          
          // CRITICAL: Convert from source timezone to UTC
          // fromZonedTime interprets the date string as being in sourceTimezone
          // and returns the corresponding UTC Date object
          const utcDate = fromZonedTime(dateString, sourceTimezone);
          
          // Convert to ISO string (which is in UTC)
          const isoString = utcDate.toISOString();
          
          // DEBUG: Log the parsing details
          console.log(`[CalendarService] Time parsing: "${t}" -> Local: ${dateString} (${sourceTimezone}) -> UTC: ${isoString}`);
          
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
  private dataQualityService: DataQualityService;
  
  // Cache for calendar events (5 minutes TTL)
  private cache = new Map<string, { data: CalendarEvent[], expires: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  // Cache for detected timezone (1 hour TTL)
  private detectedTimezone: string | null = null;
  private timezoneDetectionTime: number = 0;
  private readonly TIMEZONE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.dataQualityService = new DataQualityService();
  }

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
   * Get ForexFactory timezone with caching (1 hour TTL)
   */
  private async getForexFactoryTimezone(): Promise<string> {
    // Check cache first
    const now = Date.now();
    if (this.detectedTimezone && (now - this.timezoneDetectionTime) < this.TIMEZONE_CACHE_TTL) {
      console.log(`[CalendarService] Using cached timezone: ${this.detectedTimezone}`);
      return this.detectedTimezone;
    }
    
    // Detect timezone from ForexFactory
    console.log('[CalendarService] Detecting timezone from ForexFactory...');
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });
    
    try {
      const timezone = await this.detectForexFactoryTimezone(page);
      // Cache the result
      this.detectedTimezone = timezone;
      this.timezoneDetectionTime = now;
      console.log(`[CalendarService] Timezone detected and cached: ${timezone}`);
      return timezone;
    } finally {
      await page.close();
    }
  }

  /**
   * Detect timezone from ForexFactory website by reading the /timezone page
   * ForexFactory stores timezone in user's session/cookies
   */
  private async detectForexFactoryTimezone(page: Page): Promise<string> {
    try {
      // Navigate to timezone settings page
      await page.goto('https://www.forexfactory.com/timezone', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      // Wait for page to fully load
      await page.waitForTimeout(2000);
      
      // Extract timezone from the settings page
      const timezoneInfo = await page.evaluate(() => {
        // @ts-ignore
        const bodyText = document.body.textContent || '';
        
        // Look for timezone in format "(GMT+02:00) Bucharest"
        const gmtMatch = bodyText.match(/\(GMT([+-]\d{2}:\d{2})\)\s*([A-Za-z\s,]+)/);
        
        return {
          rawText: gmtMatch ? gmtMatch[0] : null,
          offset: gmtMatch ? gmtMatch[1] : null,
          city: gmtMatch ? gmtMatch[2].trim() : null
        };
      });
      
      console.log(`[CalendarService] ForexFactory timezone detected:`, timezoneInfo);
      
      // Map detected timezone to IANA timezone ID
      if (!timezoneInfo.offset) {
        console.warn('[CalendarService] Could not detect timezone, using default Europe/Kiev');
        return 'Europe/Kiev';
      }
      
      // Map common GMT offsets to timezones
      const offsetMap: Record<string, string> = {
        '+02:00': 'Europe/Kiev',      // Kyiv, Bucharest
        '+03:00': 'Europe/Moscow',     // Moscow
        '+00:00': 'Europe/London',     // London (GMT)
        '+01:00': 'Europe/Paris',      // Paris, Berlin
        '-05:00': 'America/New_York',  // EST
        '-08:00': 'America/Los_Angeles', // PST
        '+08:00': 'Asia/Shanghai',     // Shanghai
        '+09:00': 'Asia/Tokyo',        // Tokyo
      };
      
      const detectedTz = offsetMap[timezoneInfo.offset] || 'Europe/Kiev';
      console.log(`[CalendarService] Using timezone: ${detectedTz}`);
      
      return detectedTz;
    } catch (error) {
      console.error('[CalendarService] Error detecting timezone:', error);
      return 'Europe/Kiev';
    }
  }

  /**
   * Fetch HTML using Playwright to bypass Cloudflare
   * Note: ForexFactory ignores browser timezone and uses user's session timezone
   */
  private async fetchHTML(url: string): Promise<string> {
    const browser = await this.getBrowser();
    const page: Page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
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
    
    // IMPORTANT: Detect ForexFactory timezone BEFORE fetching HTML
    // ForexFactory shows times in user's configured timezone (from session/cookies)
    const sourceTimezone = await this.getForexFactoryTimezone();
    console.log(`[CalendarService] Using source timezone: ${sourceTimezone}`);
    
    const html = await this.fetchHTML(url);

    const $ = cheerio.load(html);
    const events: CalendarEvent[] = [];
    // Base date in detected source timezone
    const baseDate = url.includes('tomorrow')
      ? dayjs().tz(sourceTimezone).add(1, 'day')
      : dayjs().tz(sourceTimezone);

    const allRows = $('table.calendar__table tr');
    console.log(`[CalendarService] Found ${allRows.length} total rows in calendar table`);
    
    let rowsProcessed = 0;
    let eventsFound = 0;
    let eventsFiltered = 0;
    
    // IMPORTANT: ForexFactory shows time only for the first event in a group
    // We need to remember the last seen time and apply it to events without time
    let lastSeenTime = '—';

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
      
      // Read time from the cell
      const timeRaw = $row.find('.calendar__time').text().trim();
      
      // If time is present and not empty, remember it for next events
      // ForexFactory shows time only once for a group of events at the same time
      let time: string;
      if (timeRaw && timeRaw !== '' && timeRaw !== '—' && !isSpecialTimeString(timeRaw)) {
        lastSeenTime = timeRaw;
        time = timeRaw;
      } else if (timeRaw === '' || timeRaw === '—') {
        // Empty cell - use last seen time from previous row
        time = lastSeenTime;
      } else {
        // Special time string (Tentative, All Day, etc.)
        time = timeRaw;
        lastSeenTime = '—'; // Reset last seen time for special cases
      }
      
      const forecast = $row.find('.calendar__forecast').text().trim() || '—';
      const previous = $row.find('.calendar__previous').text().trim() || '—';
      const actualRaw = $row.find('.calendar__actual').text().trim() || '—';
      // Treat PENDING and similar as no data so we don't show "РЕЗУЛЬТАТ" until real value is available
      const actual = isPlaceholderActual(actualRaw) ? '—' : (actualRaw || '—');

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

      // Filter only by impact (High or Medium)
      // Currency filtering is now done per-user in SchedulerService
      const allowed = (impact === 'High' || impact === 'Medium');
      if (!allowed) {
        eventsFiltered++;
        if (eventsFiltered <= 5) { // Log first 5 filtered events
          console.log(`[CalendarService] Filtered: "${title}" [${currency}] ${impact} - reason: low impact`);
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

      const timeISO = parseTimeToISO(time, baseDate, sourceTimezone);
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

    // IMPORTANT: Apply data quality checks before caching/returning
    console.log(`[CalendarService] Applying data quality checks...`);
    const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);
    
    // Log issues if any
    if (issues.length > 0) {
      console.log(`[CalendarService] Data quality issues found: ${issues.length}`);
      // Save issues to database for analysis
      issues.forEach(issue => {
        database.logDataIssue(
          issue.eventId,
          issue.source,
          issue.type,
          issue.message,
          issue.details
        );
      });
      // Also log the first few to console
      issues.slice(0, 5).forEach(issue => {
        console.log(`  - ${issue.type}: ${issue.message}`);
      });
      
      // NOTE: Automatic critical data quality alerts are DISABLED
      // Use manual scripts (e.g., daily-quality-report.ts) to send alerts on demand
      // 
      // const criticalIssues = issues.filter(i => 
      //   i.type === 'MISSING_REQUIRED_FIELD' ||
      //   i.type === 'TIME_INCONSISTENCY' ||
      //   i.type === 'INVALID_RANGE'
      // );
      // if (criticalIssues.length > 0) {
      //   const urlType = url.includes('tomorrow') ? 'Tomorrow' : 'Today';
      //   sendCriticalDataAlert(criticalIssues, `ForexFactory Calendar (${urlType}`)
      //     .catch(err => console.error('[CalendarService] Failed to send alert:', err));
      // }
    }

    // Store validated events in cache
    this.cache.set(url, {
      data: valid,
      expires: Date.now() + this.CACHE_TTL
    });
    console.log(`[CalendarService] Cached ${valid.length} validated events for ${url}`);

    return valid;
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
