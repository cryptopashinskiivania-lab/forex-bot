/**
 * MyfxbookService (Playwright-based) is deprecated.
 * The app uses MyfxbookRssService for MyFxBook calendar.
 * This stub keeps the same API but returns empty arrays (no Playwright dependency).
 */
import { CalendarEvent } from '../types/calendar';

export class MyfxbookService {
  async getEventsForTodayRaw(): Promise<CalendarEvent[]> {
    return [];
  }

  async getEventsForToday(_userTimezone?: string): Promise<CalendarEvent[]> {
    return [];
  }

  async getEventsForTomorrow(_userTimezone?: string): Promise<CalendarEvent[]> {
    return [];
  }

  async close(): Promise<void> {}
}
