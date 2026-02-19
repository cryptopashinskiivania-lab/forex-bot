/**
 * ForexFactory calendar via CSV export.
 * Fetches https://nfs.faireconomy.media/ff_calendar_thisweek.csv
 * (Title, Country, Date, Time, Impact, Forecast, Previous, URL).
 * 60-minute cache (CSV updates hourly; requests more frequent than 5 min can get 429).
 * High/Medium impact only.
 *
 * ВАЖНО: Время в CSV от faireconomy.media задано в UTC (не Eastern).
 * Проверено по релизам: Unemployment Claims 8:30 EST = 13:30 UTC (в CSV "1:30pm"),
 * Pending Home Sales 10:00 EST = 15:00 UTC (в CSV "3:00pm"), FOMC Minutes 14:00 EST = 19:00 UTC (в CSV "7:00pm").
 */
import axios from 'axios';
import Papa from 'papaparse';
import { fromZonedTime } from 'date-fns-tz';
import { CalendarEvent } from '../types/calendar';
import { DataQualityService } from './DataQualityService';
import { database } from '../db/database';

const CSV_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.csv';
/** Время в CSV — UTC (nfs.faireconomy.media), не America/New_York. */
const CSV_TIMEZONE = 'UTC';
// 60 min — кэш снижает частоту запросов и нагрузку при частых вызовах от scheduler/пользователей
const CACHE_TTL_MS = 60 * 60 * 1000;

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
 * Parse Date (MM-DD-YYYY) and Time (h:mma e.g. "3:30pm") in CSV_TIMEZONE (UTC) to ISO string.
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
    const utcDate = fromZonedTime(localStr, CSV_TIMEZONE);
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
    const startTime = Date.now();
    const startMem = process.memoryUsage().heapUsed;

    if (this.cache && this.cache.expires > Date.now()) {
      return this.cache.data;
    }

    let csvText: string;
    try {
      csvText = await this.fetchCsv();
    } catch (err) {
      if (isRateLimitError(err)) {
        console.warn('[ForexFactoryCsv] Rate limited (429). Using cache or empty.');
        if (this.cache) return this.cache.data;
        return [];
      }
      throw err;
    }

    const valid = this.parseCsvToEvents(csvText);
    this.cache = { data: valid, expires: Date.now() + CACHE_TTL_MS };

    const endMem = process.memoryUsage().heapUsed;
    const duration = Date.now() - startTime;
    const memDelta = ((endMem - startMem) / 1024 / 1024).toFixed(2);
    console.log(
      `[ForexFactoryCsv] Parsed ${valid.length} events in ${duration}ms, RAM delta: ${memDelta}MB`
    );
    return valid;
  }

  /**
   * Return all events from the week CSV. Day filtering ("today" / "tomorrow")
   * is done by the aggregation layer in the user's timezone, so users in any
   * timezone see the correct events for their local day.
   */
  async getEventsForToday(_userTimezone?: string): Promise<CalendarEvent[]> {
    return this.fetchAndParseCsv();
  }

  /**
   * Same as getEventsForToday: full week. Aggregation filters by user's "tomorrow".
   */
  async getEventsForTomorrow(_userTimezone?: string): Promise<CalendarEvent[]> {
    return this.fetchAndParseCsv();
  }

  async close(): Promise<void> {
    this.cache = null;
  }
}
