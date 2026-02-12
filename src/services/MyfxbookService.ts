import { chromium, Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { fromZonedTime } from 'date-fns-tz';
import { CalendarEvent } from './CalendarService';
import { database } from '../db/database';
import { DataQualityService } from './DataQualityService';
import { sendCriticalDataAlert } from '../utils/adminAlerts';
import { isPlaceholderActual } from '../utils/calendarValue';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const DEFAULT_TZ = 'Europe/Kyiv';
const MYFXBOOK_TZ = 'GMT'; // Myfxbook uses GMT as base timezone

const CALENDAR_URL_TODAY = 'https://www.myfxbook.com/forex-economic-calendar';
const CALENDAR_URL_TOMORROW = 'https://www.myfxbook.com/forex-economic-calendar?day=tomorrow';

function getTimezone(): string {
  return process.env.TZ || process.env.TIMEZONE || DEFAULT_TZ;
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-' || t === '';
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
  
  // Try to parse the time string (format: "Jan 21, 07:00" or "07:00")
  try {
    // If it contains date info, parse it
    if (t.includes(',')) {
      // Format: "Jan 21, 07:00"
      const formats = [
        'MMM D, HH:mm',
        'MMM DD, HH:mm',
        'MMM D, H:mm',
        'MMM DD, H:mm',
      ];
      
      for (const fmt of formats) {
        try {
          // Parse time as GMT timezone
          const parsed = dayjs.tz(t, fmt, MYFXBOOK_TZ);
          if (parsed.isValid()) {
            // Convert from GMT to UTC using date-fns-tz
            const year = parsed.year();
            const month = String(parsed.month() + 1).padStart(2, '0');
            const day = String(parsed.date()).padStart(2, '0');
            const hours = String(parsed.hour()).padStart(2, '0');
            const minutes = String(parsed.minute()).padStart(2, '0');
            const seconds = String(parsed.second()).padStart(2, '0');
            const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            
            // Convert from GMT timezone to UTC (GMT is effectively UTC, but we use fromZonedTime for consistency)
            const utcDate = fromZonedTime(dateString, MYFXBOOK_TZ);
            
            // Convert to ISO string (which is in UTC)
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
      // Format: "07:00" - use baseDate
      const dateStr = baseDate.format('YYYY-MM-DD');
      const combined = `${dateStr} ${t}`;
      const formats = ['YYYY-MM-DD HH:mm', 'YYYY-MM-DD H:mm'];
      
      for (const fmt of formats) {
        try {
          // Parse time as GMT timezone
          const parsed = dayjs.tz(combined, fmt, MYFXBOOK_TZ);
          if (parsed.isValid()) {
            // Convert from GMT to UTC using date-fns-tz
            const year = parsed.year();
            const month = String(parsed.month() + 1).padStart(2, '0');
            const day = String(parsed.date()).padStart(2, '0');
            const hours = String(parsed.hour()).padStart(2, '0');
            const minutes = String(parsed.minute()).padStart(2, '0');
            const seconds = String(parsed.second()).padStart(2, '0');
            const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            
            // Convert from GMT timezone to UTC (GMT is effectively UTC, but we use fromZonedTime for consistency)
            const utcDate = fromZonedTime(dateString, MYFXBOOK_TZ);
            
            // Convert to ISO string (which is in UTC)
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
    console.warn(`[MyfxbookService] Error parsing time "${t}":`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

function parseImpact(impactText: string): 'High' | 'Medium' | 'Low' {
  const impact = impactText.trim().toLowerCase();
  if (impact.includes('high')) return 'High';
  if (impact.includes('medium')) return 'Medium';
  return 'Low';
}

export class MyfxbookService {
  private browser: Browser | null = null;
  private browserLock: Promise<Browser> | null = null;
  private dataQualityService: DataQualityService;
  // Cache for calendar events (5 minutes TTL)
  private cache = new Map<string, { data: CalendarEvent[], expires: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

  constructor() {
    this.dataQualityService = new DataQualityService();
  }

  /**
   * Initialize browser instance with anti-detection settings
   */
  private async getBrowser(): Promise<Browser> {
    // If browser is already being launched, wait for it
    if (this.browserLock) {
      console.log('[MyfxbookService] Waiting for browser to launch...');
      return this.browserLock;
    }
    
    if (!this.browser || !this.browser.isConnected()) {
      console.log('[MyfxbookService] Launching Chromium browser...');
      
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
        console.log('[MyfxbookService] Browser launched successfully');
      } finally {
        this.browserLock = null;
      }
    }
    return this.browser;
  }

  /**
   * Fetch HTML using Playwright to bypass Cloudflare protection
   */
  private async fetchHTML(url: string): Promise<string> {
    const browser = await this.getBrowser();
    let page: Page | null = null;

    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'GMT',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });

      page = await context.newPage();

      console.log(`[MyfxbookService] Navigating to ${url}...`);
      
      // Navigate to page with reduced timeout
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000, // Reduced from 30s to 15s
      });

      // Wait for calendar data to load with reduced timeout
      console.log('[MyfxbookService] Waiting for calendar data...');
      // Myfxbook might load data dynamically, so wait for either table or data elements
      await Promise.race([
        page.waitForSelector('table', { timeout: 10000 }), // Reduced from 20s to 10s
        page.waitForSelector('.calendar-row', { timeout: 10000 }),
        page.waitForTimeout(3000), // Reduced fallback from 5s to 3s
      ]).catch(() => {
        console.warn('[MyfxbookService] Timeout waiting for calendar elements, continuing anyway...');
      });

      // Reduced additional wait from 2s to 1s
      await page.waitForTimeout(1000);

      // Get page content
      const html = await page.content();
      console.log('[MyfxbookService] Successfully fetched HTML');

      // Close page and context
      await page.close();
      await context.close();

      return html;
    } catch (error) {
      console.error('[MyfxbookService] Error fetching HTML:', error);
      
      // Cleanup on error
      if (page) {
        try {
          await page.close();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
      throw new Error(`Failed to fetch Myfxbook calendar: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
    // Check cache first
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      console.log(`[MyfxbookService] Using cached data for ${url} (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.data;
    }

    console.log(`[MyfxbookService] Cache miss or expired for ${url}, fetching fresh data...`);
    
    try {
      const html = await this.fetchHTML(url);

      const $ = cheerio.load(html);
      const events: CalendarEvent[] = [];
      
      // Myfxbook calendar structure - try to find table rows with events
      // The page might load data dynamically, so we'll try multiple selectors
      const baseDate = url.includes('tomorrow')
        ? dayjs().tz(MYFXBOOK_TZ).add(1, 'day')
        : dayjs().tz(MYFXBOOK_TZ);

      // Myfxbook table structure:
      // Col 0: Date/Time
      // Col 1: Time left
      // Col 2: (empty)
      // Col 3: Currency
      // Col 4: Event name
      // Col 5: Impact
      // Col 6: Previous
      // Col 7: Consensus (Forecast)
      // Col 8: Actual
      
      $('table tr').each((_, rowEl) => {
        try {
          const $row = $(rowEl);
          const $cells = $row.find('td');
          
          // Skip rows with less than 9 columns
          if ($cells.length < 9) {
            return;
          }
          
          // Extract data from correct columns
          const timeText = $cells.eq(0).text().trim() || '';
          const currency = $cells.eq(3).text().trim() || '';
          const title = $cells.eq(4).text().trim() || '';
          const impactText = $cells.eq(5).text().trim() || '';
          const previous = $cells.eq(6).text().trim() || '—';
          const forecast = $cells.eq(7).text().trim() || '—';
          const actualRaw = $cells.eq(8).text().trim() || '—';
          // Treat PENDING and similar as no data so we don't show "РЕЗУЛЬТАТ" until real value is available
          const actual = isPlaceholderActual(actualRaw) ? '—' : (actualRaw || '—');
          
          // Skip invalid rows
          if (!currency || !title || currency.length > 3) {
            return;
          }
          
          // Skip header rows
          if (currency === 'Currency' || title.includes('Date') || title.includes('Event')) {
            return;
          }
          
          const impact = parseImpact(impactText);

          // Filter only by impact (High or Medium)
          // Currency filtering is now done per-user in SchedulerService
          const allowed = (impact === 'High' || impact === 'Medium');
          if (!allowed) return;

          const noActual = isEmpty(actual);
          const noForecast = isEmpty(forecast);
          const noPrevious = isEmpty(previous);
          const allEmpty = noActual && noForecast && noPrevious;
          const isSpeechMinutesStatement =
            /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(title);
          if (allEmpty && !isSpeechMinutesStatement) return;

          // Parse time
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
          // Continue with next row
        }
      });

      // If no events found with standard selectors, try alternative approach
      // Myfxbook might load data via JavaScript, so we might need to check for JSON data
      if (events.length === 0) {
        console.warn('[MyfxbookService] No events found with standard selectors, page might be dynamically loaded');
        // Could try to find JSON data in script tags
        $('script').each((_, scriptEl) => {
          const scriptContent = $(scriptEl).html() || '';
          // Look for JSON data containing calendar events
          // This is a fallback if the page structure is different
        });
      }

      console.log(`[MyfxbookService] Found ${events.length} events from ${url}`);
      
      // IMPORTANT: Apply data quality checks before caching/returning
      console.log(`[MyfxbookService] Applying data quality checks...`);
      const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);
      
      // Log issues if any
      if (issues.length > 0) {
        console.log(`[MyfxbookService] Data quality issues found: ${issues.length}`);
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
        //   sendCriticalDataAlert(criticalIssues, `Myfxbook Calendar (${urlType}`)
        //     .catch(err => console.error('[MyfxbookService] Failed to send alert:', err));
        // }
      }
      
      // Store validated events in cache
      this.cache.set(url, {
        data: valid,
        expires: Date.now() + this.CACHE_TTL
      });
      console.log(`[MyfxbookService] Cached ${valid.length} validated events for ${url}`);
      
      return valid;
    } catch (error) {
      console.error('[MyfxbookService] Error fetching events:', error);
      return [];
    }
  }

  /**
   * Get today's events. Optional userTimezone: if provided, "today" is in user's timezone (for multi-user bot).
   */
  async getEventsForToday(userTimezone?: string): Promise<CalendarEvent[]> {
    const events = await this.fetchEvents(CALENDAR_URL_TODAY);
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const todayStart = nowLocal.startOf('day');
    const todayEnd = nowLocal.endOf('day');

    const filtered = events.filter(event => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(todayStart) && eventDate.isBefore(todayEnd);
    });
    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = events.length - filtered.length;
      if (filteredOut > 0) {
        console.log(`[MyfxbookService] Today (${tz}): ${filtered.length} events, ${filteredOut} filtered out`);
      }
    }
    return filtered;
  }

  /**
   * Get tomorrow's events. Optional userTimezone: if provided, "tomorrow" is in user's timezone.
   */
  async getEventsForTomorrow(userTimezone?: string): Promise<CalendarEvent[]> {
    const events = await this.fetchEvents(CALENDAR_URL_TOMORROW);
    const tz = userTimezone || getTimezone();
    const nowLocal = dayjs.tz(new Date(), tz);
    const tomorrowStart = nowLocal.add(1, 'day').startOf('day');
    const tomorrowEnd = nowLocal.add(1, 'day').endOf('day');

    const filtered = events.filter(event => {
      if (!event.timeISO) return false;
      const eventDate = dayjs(event.timeISO).tz(tz);
      return eventDate.isAfter(tomorrowStart) && eventDate.isBefore(tomorrowEnd);
    });
    if (process.env.LOG_LEVEL === 'debug') {
      const filteredOut = events.length - filtered.length;
      if (filteredOut > 0) {
        console.log(`[MyfxbookService] Tomorrow (${tz}): ${filtered.length} events, ${filteredOut} filtered out`);
      }
    }
    return filtered;
  }

  /**
   * Close the browser instance
   * Call this when shutting down the service
   */
  async close(): Promise<void> {
    if (this.browser) {
      console.log('[MyfxbookService] Closing browser...');
      await this.browser.close();
      this.browser = null;
    }
  }
}
