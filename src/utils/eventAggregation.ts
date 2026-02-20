import crypto from 'crypto';
import { parseISO } from 'date-fns';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ForexFactoryCsvService } from '../services/ForexFactoryCsvService';
import { CalendarEvent } from '../types/calendar';
import { DataQualityService } from '../services/DataQualityService';

/** Minimal interface for MyFxBook calendar (implemented by MyfxbookService). */
export interface MyfxbookCalendarSource {
  getEventsForTodayRaw(): Promise<CalendarEvent[]>;
  getEventsForToday(userTimezone?: string): Promise<CalendarEvent[]>;
  getEventsForTomorrow(userTimezone?: string): Promise<CalendarEvent[]>;
}
import { database } from '../db/database';
import { isPlaceholderActual } from './calendarValue';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Cache for events filtered by (source, day, tz) to avoid repeated filter passes (Phase 2.1). */
const FILTERED_EVENTS_CACHE_TTL_MS = 5 * 60 * 1000;
const filteredByTzCache = new Map<string, { data: CalendarEvent[]; expires: number }>();

function getCachedFilteredEvents(source: 'Myfxbook', day: 'today' | 'tomorrow', tz: string): CalendarEvent[] | null {
  const key = `${source}_${day}_${tz}`;
  const entry = filteredByTzCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

function setCachedFilteredEvents(source: 'Myfxbook', day: 'today' | 'tomorrow', tz: string, data: CalendarEvent[]): void {
  const key = `${source}_${day}_${tz}`;
  filteredByTzCache.set(key, { data, expires: Date.now() + FILTERED_EVENTS_CACHE_TTL_MS });
}

/**
 * Generate MD5 hash from string
 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/**
 * Check if a string value is empty or placeholder
 */
function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
}

/** Shared calendar data: one fetch per source per run, then filter per user. */
export interface SharedCalendarToday {
  forexFactory: CalendarEvent[];
  myfxbook: CalendarEvent[];
}

/** User impact filter: high_only = red, medium_only = yellow, both = red + yellow. */
function filterEventsByImpact(
  events: CalendarEvent[],
  filter: 'high_only' | 'medium_only' | 'both'
): CalendarEvent[] {
  if (filter === 'both') return events;
  if (filter === 'high_only') return events.filter((e) => e.impact === 'High');
  return events.filter((e) => e.impact === 'Medium');
}

/**
 * Filter events to those that fall on "today" or "tomorrow" in the given timezone.
 */
function filterEventsToUserDay(
  events: CalendarEvent[],
  userTz: string,
  forTomorrow: boolean
): CalendarEvent[] {
  const dayStart = forTomorrow
    ? dayjs.tz(dayjs(), userTz).add(1, 'day').startOf('day')
    : dayjs.tz(dayjs(), userTz).startOf('day');
  const dayEnd = forTomorrow
    ? dayjs.tz(dayjs(), userTz).add(1, 'day').endOf('day')
    : dayjs.tz(dayjs(), userTz).endOf('day');
  return events.filter((event) => {
    if (!event.timeISO) return true;
    const t = dayjs(event.timeISO);
    return (t.isAfter(dayStart) || t.isSame(dayStart)) && (t.isBefore(dayEnd) || t.isSame(dayEnd));
  });
}

/**
 * Fetch calendar data once per run (2 browser calls total).
 * Used by scheduler so 400 users don't trigger 400 fetches.
 */
export async function fetchSharedCalendarToday(
  forexFactoryService: ForexFactoryCsvService,
  myfxbookService: MyfxbookCalendarSource
): Promise<SharedCalendarToday> {
  const [forexFactory, myfxbook] = await Promise.all([
    forexFactoryService.getEventsForToday().catch((err) => {
      console.error('[EventAggregation] Error fetching ForexFactory for shared calendar:', err);
      return [];
    }),
    myfxbookService.getEventsForTodayRaw().catch((err) => {
      console.error('[EventAggregation] Error fetching Myfxbook for shared calendar:', err);
      return [];
    }),
  ]);
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`[EventAggregation] Shared fetch: FF=${forexFactory.length}, Myfxbook=${myfxbook.length}`);
  }
  // Debug: log first 5 MyFxBook events (currency, title, time, timeISO) to diagnose filtering
  if (myfxbook.length > 0) {
    const sample = myfxbook.slice(0, 5);
    console.log(`[EventAggregation] MyFxBook first ${sample.length} events:`);
    sample.forEach((e, i) => {
      console.log(`  [${i + 1}] currency=${e.currency} title="${e.title}" time=${e.time} timeISO=${e.timeISO ?? 'n/a'}`);
    });
  }
  return { forexFactory, myfxbook };
}

/**
 * Get events for one user from pre-fetched shared data (no browser calls).
 * Filters by user timezone "today", news source preference, dedupes within source.
 */
export function getEventsForUserFromShared(
  shared: SharedCalendarToday,
  userId: number
): CalendarEvent[] {
  const newsSource = database.getNewsSource(userId);
  const userTz = database.getTimezone(userId);

  const ffFiltered = filterEventsToUserDay(shared.forexFactory, userTz, false);
  const mbFiltered = filterEventsToUserDay(shared.myfxbook, userTz, false);

  const fetchForexFactory = newsSource === 'ForexFactory' || newsSource === 'Both';
  const fetchMyfxbook = newsSource === 'Myfxbook' || newsSource === 'Both';

  const allEvents: CalendarEvent[] = [];
  if (fetchForexFactory) allEvents.push(...ffFiltered);
  if (fetchMyfxbook) allEvents.push(...mbFiltered);

  const deduplicationMap = new Map<string, CalendarEvent>();
  const seenKeys = new Set<string>();
  for (const event of allEvents) {
    const key = deduplicationKey(event);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicationMap.set(key, event);
    } else {
      const existing = deduplicationMap.get(key);
      if (existing) {
        const existingHasData = !isPlaceholderActual(existing.actual) || !isEmpty(existing.forecast);
        const currentHasData = !isPlaceholderActual(event.actual) || !isEmpty(event.forecast);
        const shouldReplace =
          (currentHasData && !existingHasData) ||
          (event.impact === 'High' && existing.impact !== 'High');
        if (shouldReplace) deduplicationMap.set(key, event);
      }
    }
  }
  const events = Array.from(deduplicationMap.values());
  const impactFilter = database.getNewsImpactFilter(userId);
  return filterEventsByImpact(events, impactFilter);
}

/**
 * Generate deduplication key based on source, time, currency AND title
 * Used to detect duplicate events WITHIN THE SAME source only
 * Events from different sources are NOT considered duplicates
 */
function deduplicationKey(event: CalendarEvent): string {
  let timeKey = event.timeISO || event.time;
  
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      // Round to nearest 5 minutes to catch near-duplicate events
      const roundedMinutes = Math.floor(eventTime.getMinutes() / 5) * 5;
      const roundedTime = new Date(eventTime);
      roundedTime.setMinutes(roundedMinutes, 0, 0);
      timeKey = roundedTime.toISOString().substring(0, 16); // YYYY-MM-DDTHH:mm
    } catch {
      // If parsing fails, use original time
    }
  }
  
  // Normalize title for better matching (lowercase, remove extra spaces)
  const normalizedTitle = event.title.toLowerCase().trim().replace(/\s+/g, ' ');
  
  // IMPORTANT: Include source AND title in the key so events with same time+currency but different titles are NOT deduplicated
  return md5(`${event.source}_${timeKey}_${event.currency}_${normalizedTitle}`);
}

/**
 * Aggregate Core news sources (ForexFactory + Myfxbook)
 * 
 * This function:
 * 1. Fetches events from ForexFactory and/or Myfxbook based on user preference
 * 2. Deduplicates events WITHIN each source only (same source + time + currency)
 * 3. Events from different sources are shown separately (no cross-source deduplication)
 * 
 * IMPORTANT: If user selects "Both" sources, events from ForexFactory and Myfxbook
 * are displayed independently, even if they represent the same real-world event.
 * This is by design - each source is treated as an independent news provider.
 * 
 * @param forexFactoryService - ForexFactory CSV service instance
 * @param myfxbookService - Myfxbook service instance
 * @param userId - User ID to get news source preference
 * @param forTomorrow - If true, fetch tomorrow's events; otherwise today's
 * @returns Array of calendar events (deduplicated within each source)
 */
export async function aggregateCoreEvents(
  forexFactoryService: ForexFactoryCsvService,
  myfxbookService: MyfxbookCalendarSource,
  userId: number,
  forTomorrow: boolean = false
): Promise<CalendarEvent[]> {
  try {
    const newsSource = database.getNewsSource(userId);
    const userTz = database.getTimezone(userId);

    const fetchForexFactory = newsSource === 'ForexFactory' || newsSource === 'Both';
    const fetchMyfxbook = newsSource === 'Myfxbook' || newsSource === 'Both';

    const dayKey = forTomorrow ? 'tomorrow' : 'today';
    let myfxbookEvents: CalendarEvent[] = [];
    if (fetchMyfxbook) {
      const cached = getCachedFilteredEvents('Myfxbook', dayKey, userTz);
      if (cached !== null) {
        myfxbookEvents = cached;
      } else {
        myfxbookEvents = await (forTomorrow
          ? myfxbookService.getEventsForTomorrow(userTz)
          : myfxbookService.getEventsForToday(userTz)
        ).catch(err => {
          console.error('[EventAggregation] Error fetching Myfxbook events:', err);
          return [];
        });
        setCachedFilteredEvents('Myfxbook', dayKey, userTz, myfxbookEvents);
      }
    }

    const forexFactoryEvents = fetchForexFactory
      ? await (forTomorrow
          ? forexFactoryService.getEventsForTomorrow()
          : forexFactoryService.getEventsForToday()
        ).catch(err => {
          console.error('[EventAggregation] Error fetching ForexFactory events:', err);
          return [];
        })
      : [];

    const userInfo = `User ${userId} | Source: ${newsSource} | ${forTomorrow ? 'Tomorrow' : 'Today'} | `;
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[EventAggregation] ${userInfo}ForexFactory: ${forexFactoryEvents.length}, Myfxbook: ${myfxbookEvents.length}`);
    }

    // Combine all events
    const allEvents = [...forexFactoryEvents, ...myfxbookEvents];
    
    // Deduplication WITHIN each source only (not across sources)
    // If same source + time (within 5 min) + currency, keep only one
    const deduplicationMap = new Map<string, CalendarEvent>();
    const seenKeys = new Set<string>();
    
    for (const event of allEvents) {
      const key = deduplicationKey(event);
      
      if (!seenKeys.has(key)) {
        // First time seeing this event (source + time + currency combination)
        seenKeys.add(key);
        deduplicationMap.set(key, event);
      } else {
        // Duplicate within SAME source - keep the better one
        const existing = deduplicationMap.get(key);
        if (existing) {
          const existingHasData = !isPlaceholderActual(existing.actual) || !isEmpty(existing.forecast);
          const currentHasData = !isPlaceholderActual(event.actual) || !isEmpty(event.forecast);
          
          // Decision logic (in order of priority):
          // 1. Prefer event with actual/forecast data
          // 2. Prefer High impact over Medium/Low
          const shouldReplace = 
            (currentHasData && !existingHasData) ||
            (event.impact === 'High' && existing.impact !== 'High');
          
          if (shouldReplace) {
            deduplicationMap.set(key, event);
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`[EventAggregation] Replaced duplicate within ${event.source}: ${existing.title} → ${event.title}`);
            }
          } else if (process.env.LOG_LEVEL === 'debug') {
            console.log(`[EventAggregation] Kept existing in ${existing.source}: ${existing.title}, skipped: ${event.title}`);
          }
        }
      }
    }
    
    let deduplicatedEvents = Array.from(deduplicationMap.values());

    // Filter by user's calendar day in their timezone (so "today"/"tomorrow" match user's local date)
    const dayStart = forTomorrow
      ? dayjs.tz(dayjs(), userTz).add(1, 'day').startOf('day')
      : dayjs.tz(dayjs(), userTz).startOf('day');
    const dayEnd = forTomorrow
      ? dayjs.tz(dayjs(), userTz).add(1, 'day').endOf('day')
      : dayjs.tz(dayjs(), userTz).endOf('day');
    const before = deduplicatedEvents.length;
    deduplicatedEvents = deduplicatedEvents.filter(event => {
      if (!event.timeISO) return true; // keep events without time (e.g. All Day)
      const t = dayjs(event.timeISO);
      return (t.isAfter(dayStart) || t.isSame(dayStart)) && (t.isBefore(dayEnd) || t.isSame(dayEnd));
    });
    if (process.env.LOG_LEVEL === 'debug' && before !== deduplicatedEvents.length) {
      console.log(`[EventAggregation] ${userInfo}Filtered to user day in ${userTz}: ${deduplicatedEvents.length} events (was ${before})`);
    }

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[EventAggregation] ${userInfo}Total events: ${deduplicatedEvents.length}`);
    }

    // Apply user impact filter (red only / yellow only / both)
    const impactFilter = database.getNewsImpactFilter(userId);
    deduplicatedEvents = filterEventsByImpact(deduplicatedEvents, impactFilter);

    // Check for cross-source conflicts (if both sources are active)
    if (forexFactoryEvents.length > 0 && myfxbookEvents.length > 0) {
      const dataQualityService = new DataQualityService();
      const conflicts = dataQualityService.checkCrossSourceConflicts(allEvents);
      
      if (conflicts.length > 0) {
        console.log(`[EventAggregation] Found ${conflicts.length} cross-source conflicts`);
        // Log conflicts to database
        conflicts.forEach(conflict => {
          database.logDataIssue(
            undefined,
            conflict.source,
            conflict.type,
            conflict.message,
            conflict.details
          );
        });
      }
    }
    
    return deduplicatedEvents;
  } catch (error) {
    console.error('[EventAggregation] Error aggregating Core events:', error);
    // Fallback to ForexFactory only if aggregation fails
    return forTomorrow
      ? forexFactoryService.getEventsForTomorrow().catch(() => [])
      : forexFactoryService.getEventsForToday().catch(() => []);
  }
}
