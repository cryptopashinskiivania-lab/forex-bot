import cloudscraper from 'cloudscraper';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { fromZonedTime } from 'date-fns-tz';
import { CalendarEvent } from './CalendarService';
import { database } from '../db/database';

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
  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
    try {
      const html = (await cloudscraper({
        uri: url,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      })) as string;

      const $ = cheerio.load(html);
      const events: CalendarEvent[] = [];
      
      // Myfxbook calendar structure - try to find table rows with events
      // The page might load data dynamically, so we'll try multiple selectors
      const baseDate = url.includes('tomorrow')
        ? dayjs().tz(MYFXBOOK_TZ).add(1, 'day')
        : dayjs().tz(MYFXBOOK_TZ);

      // Try to find event rows - Myfxbook uses different structure
      // Look for table rows or divs containing event data
      $('table tr, .calendar-row, [data-event]').each((_, rowEl) => {
        try {
          const $row = $(rowEl);
          
          // Try to extract currency (usually in first column or data attribute)
          const currency = $row.find('td:first-child, .currency, [data-currency]').first().text().trim() || 
                          $row.attr('data-currency') || '';
          
          // Skip header rows
          if (!currency || currency === 'Currency' || currency.length > 3 || currency.includes('Date')) {
            return;
          }

          // Extract event title
          const title = $row.find('.event-title, a[href*="economic-calendar"], td:nth-child(2) a').first().text().trim() ||
                      $row.find('td').eq(1).text().trim() ||
                      '';
          
          if (!title) return;

          // Extract time
          const timeText = $row.find('.time, .event-time, td:nth-child(2)').first().text().trim() ||
                          $row.find('td').eq(0).text().trim() || '';
          
          // Extract impact
          const impactText = $row.find('.impact, .event-impact, [data-impact]').first().text().trim() ||
                            $row.attr('data-impact') || 'Low';
          const impact = parseImpact(impactText);

          // Extract previous, consensus (forecast), actual
          const previous = $row.find('.previous, td:nth-child(3)').first().text().trim() || '—';
          const forecast = $row.find('.consensus, .forecast, td:nth-child(4)').first().text().trim() || '—';
          const actual = $row.find('.actual, td:nth-child(5)').first().text().trim() || '—';

          // Get monitored assets from database
          const monitoredAssets = database.getMonitoredAssets();
          const ALLOWED_CURRENCIES = new Set(monitoredAssets);
          
          const allowed =
            ALLOWED_CURRENCIES.has(currency) &&
            (impact === 'High' || impact === 'Medium');
          if (!allowed) return;

          const noActual = isEmpty(actual);
          const noForecast = isEmpty(forecast);
          const noPrevious = isEmpty(previous);
          const allEmpty = noActual && noForecast && noPrevious;
          const isSpeechMinutesStatement =
            /Speech|Minutes|Statement/i.test(title);
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
      return events;
    } catch (error) {
      console.error('[MyfxbookService] Error fetching events:', error);
      return [];
    }
  }

  async getEventsForToday(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TODAY);
  }

  async getEventsForTomorrow(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TOMORROW);
  }
}
