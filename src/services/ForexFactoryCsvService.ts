/**
 * ForexFactory calendar via CSV export.
 * Fetches https://nfs.faireconomy.media/ff_calendar_thisweek.csv
 * (Title, Country, Date, Time, Impact, Forecast, Previous, URL).
 * 60-minute cache (CSV updates hourly; requests more frequent than 5 min can get 429).
 * High/Medium impact only, America/New_York timezone.
 */

import axios from 'axios';
import Papa from 'papaparse';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { CalendarEvent } from '../types/calendar';
import { DataQualityService } from './DataQualityService';
import { database } from '../db/database';

const CSV_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.csv';
const FF_TZ = 'America/New_York';
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes (CSV updates hourly; rate limit ~5 min)

function isRateLimitError(err: unknown): err is { response: { status: number; headers?: Record<string, string> } } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response?: unknown }).response === 'object' &&
    (err as { response: { status?: number } }).response?.status === 429
  );
}

interface CsvRow {
  Title: string;
  Country: string;
  Date: string;
  Time: string;
  Impact: string;
  Forecast: string;
  Previous: string;
  URL: string;
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
 * Parse Date (MM-DD-YYYY) and Time (h:mma e.g. "3:30pm") in America/New_York to ISO string.
 */
function parseDateTimeToISO(dateStr: string, timeStr: string): string | undefined {
  const d = (dateStr || '').trim();
  const t = (timeStr || '').trim();
  if (!d || !t || isSpecialTimeString(t)) return undefined;

  const match = d.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) return undefined;
  const [, month, day, year] = match;
  const datePart = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  const timeMatch = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!timeMatch) return undefined;
  let hours = parseInt(timeMatch[1], 10);
  const minutes = timeMatch[2];
  const ampm = timeMatch[3].toLowerCase();
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  const timePart = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
  const localStr = `${datePart} ${timePart}`;
  try {
    const utcDate = fromZonedTime(localStr, FF_TZ);
    const iso = utcDate.toISOString();
    if (utcDate.getFullYear() >= 2000 && utcDate.getFullYear() <= 2100) return iso;
  } catch {
    // ignore
  }
  return undefined;
}

export class ForexFactoryCsvService {
  private cache: { data: CalendarEvent[]; expires: number } | null = null;
  private dataQualityService: DataQualityService;

  constructor() {
    this.dataQualityService = new DataQualityService();
  }

  private async fetchCsv(): Promise<string> {
    const response = await axios.get(CSV_URL, {
      responseType: 'text' as const,
      timeout: 15000,
      headers: { Accept: 'text/csv' },
      validateStatus: (status: number) => status === 200,
    });
    return response.data as string;
  }

  private parseCsvToEvents(csvText: string): CalendarEvent[] {
    const parsed = Papa.parse<CsvRow>(csvText, { header: true, skipEmptyLines: true });
    const rows = parsed.data || [];
    const events: CalendarEvent[] = [];

    for (const row of rows) {
      const impactRaw = (row.Impact || '').trim();
      const impact = impactRaw === 'High' ? 'High' : impactRaw === 'Medium' ? 'Medium' : 'Low';
      if (impact !== 'High' && impact !== 'Medium') continue;

      const title = (row.Title || '').trim().replace(/\s+/g, ' ');
      const currency = (row.Country || '').trim();
      if (!title || !currency) continue;

      const dateStr = (row.Date || '').trim();
      const timeStr = (row.Time || '').trim();
      const timeISO = parseDateTimeToISO(dateStr, timeStr);
      const forecast = (row.Forecast || '').trim() || '—';
      const previous = (row.Previous || '').trim() || '—';
      const actual = '—';
      const isResult = false;

      const noForecast = isEmpty(forecast);
      const noPrevious = isEmpty(previous);
      const allEmpty = noForecast && noPrevious;
      const isSpeechMinutes = /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(title);
      if (allEmpty && !isSpeechMinutes) continue;

      events.push({
        title,
        currency,
        impact,
        time: timeStr || '—',
        timeISO,
        forecast,
        previous,
        actual,
        source: 'ForexFactory',
        isResult,
      });
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
    return valid;
  }

  private async fetchAndParseCsv(): Promise<CalendarEvent[]> {
    if (this.cache && this.cache.expires > Date.now()) {
      return this.cache.data;
    }
    const start = Date.now();
    let csvText: string;
    try {
      csvText = await this.fetchCsv();
    } catch (err) {
      if (isRateLimitError(err)) {
        console.warn('[ForexFactoryCsv] Rate limited (429). Using cache or empty. Bot continues with MyFxBook RSS.');
        if (this.cache) return this.cache.data;
        return [];
      }
      throw err;
    }
    const valid = this.parseCsvToEvents(csvText);
    this.cache = { data: valid, expires: Date.now() + CACHE_TTL_MS };
    console.log(
      `[ForexFactoryCsv] Fetched ${valid.length} events in ${Date.now() - start}ms (cached 60 min)`
    );
    return valid;
  }

  private filterByDay(events: CalendarEvent[], forTomorrow: boolean): CalendarEvent[] {
    const now = new Date();
    const nyNow = toZonedTime(now, FF_TZ);
    const targetDay = new Date(nyNow.getFullYear(), nyNow.getMonth(), nyNow.getDate());
    if (forTomorrow) targetDay.setDate(targetDay.getDate() + 1);
    const targetYear = targetDay.getFullYear();
    const targetMonth = targetDay.getMonth();
    const targetDate = targetDay.getDate();

    return events.filter((e) => {
      if (!e.timeISO) return true;
      const eventUtc = new Date(e.timeISO);
      const eventNy = toZonedTime(eventUtc, FF_TZ);
      return (
        eventNy.getFullYear() === targetYear &&
        eventNy.getMonth() === targetMonth &&
        eventNy.getDate() === targetDate
      );
    });
  }

  async getEventsForToday(_userTimezone?: string): Promise<CalendarEvent[]> {
    const events = await this.fetchAndParseCsv();
    return this.filterByDay(events, false);
  }

  async getEventsForTomorrow(_userTimezone?: string): Promise<CalendarEvent[]> {
    const events = await this.fetchAndParseCsv();
    return this.filterByDay(events, true);
  }

  async close(): Promise<void> {
    this.cache = null;
  }
}
