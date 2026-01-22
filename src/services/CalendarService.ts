import cloudscraper from 'cloudscraper';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
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
        const parsed = dayjs.tz(combined, fmt, FF_TZ);
        if (parsed.isValid()) {
          const isoString = parsed.tz(getTimezone()).toISOString();
          // Validate the ISO string is reasonable (not 1970 or far future)
          const parsedDate = new Date(isoString);
          if (parsedDate.getFullYear() >= 2000 && parsedDate.getFullYear() <= 2100) {
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
  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
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
    const baseDate = url.includes('tomorrow')
      ? dayjs().tz(FF_TZ).add(1, 'day')
      : dayjs().tz(FF_TZ);

    $('table.calendar__table tr').each((_, rowEl) => {
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
      if (!allowed) return;

      const noActual = isEmpty(actual);
      const noForecast = isEmpty(forecast);
      const noPrevious = isEmpty(previous);
      const allEmpty = noActual && noForecast && noPrevious;
      const isSpeechMinutesStatement =
        /Speech|Minutes|Statement/i.test(title);
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
        isResult,
      });
    });

    return events;
  }

  async getEventsForToday(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TODAY);
  }

  async getEventsForTomorrow(): Promise<CalendarEvent[]> {
    return this.fetchEvents(CALENDAR_URL_TOMORROW);
  }
}
