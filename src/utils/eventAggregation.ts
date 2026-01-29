import crypto from 'crypto';
import { parseISO } from 'date-fns';
import { CalendarService, CalendarEvent } from '../services/CalendarService';
import { MyfxbookService } from '../services/MyfxbookService';
import { DataQualityService } from '../services/DataQualityService';
import { database } from '../db/database';

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

/**
 * Generate deduplication key based on time and currency
 * Used to detect duplicate events from different sources
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
  
  return md5(`${timeKey}_${event.currency}`);
}

/**
 * Aggregate Core news sources (ForexFactory + Myfxbook) with smart deduplication
 * 
 * This function:
 * 1. Fetches events from ForexFactory and/or Myfxbook based on user preference
 * 2. Deduplicates events using smart logic:
 *    - Events with same time (within 5 min) + same currency are considered duplicates
 *    - Prefers events with actual/forecast data
 *    - Prefers High impact over Medium/Low
 *    - Prefers ForexFactory as more reliable source (when data quality is equal)
 * 
 * @param calendarService - ForexFactory service instance
 * @param myfxbookService - Myfxbook service instance
 * @param userId - User ID to get news source preference
 * @param forTomorrow - If true, fetch tomorrow's events; otherwise today's
 * @returns Deduplicated array of calendar events
 */
export async function aggregateCoreEvents(
  calendarService: CalendarService,
  myfxbookService: MyfxbookService,
  userId: number,
  forTomorrow: boolean = false
): Promise<CalendarEvent[]> {
  try {
    // Get user's news source preference
    const newsSource = database.getNewsSource(userId);
    
    // Determine which sources to fetch
    const fetchForexFactory = newsSource === 'ForexFactory' || newsSource === 'Both';
    const fetchMyfxbook = newsSource === 'Myfxbook' || newsSource === 'Both';
    
    // Fetch from selected sources in parallel
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      fetchForexFactory
        ? (forTomorrow
            ? calendarService.getEventsForTomorrow().catch(err => {
                console.error('[EventAggregation] Error fetching ForexFactory events:', err);
                return [];
              })
            : calendarService.getEventsForToday().catch(err => {
                console.error('[EventAggregation] Error fetching ForexFactory events:', err);
                return [];
              }))
        : Promise.resolve([]),
      fetchMyfxbook
        ? (forTomorrow
            ? myfxbookService.getEventsForTomorrow().catch(err => {
                console.error('[EventAggregation] Error fetching Myfxbook events:', err);
                return [];
              })
            : myfxbookService.getEventsForToday().catch(err => {
                console.error('[EventAggregation] Error fetching Myfxbook events:', err);
                return [];
              }))
        : Promise.resolve([]),
    ]);

    const userInfo = `User ${userId} | Source: ${newsSource} | ${forTomorrow ? 'Tomorrow' : 'Today'} | `;
    console.log(`[EventAggregation] ${userInfo}ForexFactory: ${forexFactoryEvents.length}, Myfxbook: ${myfxbookEvents.length}`);

    // Combine all events
    const allEvents = [...forexFactoryEvents, ...myfxbookEvents];
    
    // Smart deduplication: if same time (within 5 min) + same currency, keep the best one
    const deduplicationMap = new Map<string, CalendarEvent>();
    const seenKeys = new Set<string>();
    
    for (const event of allEvents) {
      const key = deduplicationKey(event);
      
      if (!seenKeys.has(key)) {
        // First time seeing this event
        seenKeys.add(key);
        deduplicationMap.set(key, event);
      } else {
        // We already have an event with this key - choose the better one
        const existing = deduplicationMap.get(key);
        if (existing) {
          const existingHasData = !isEmpty(existing.actual) || !isEmpty(existing.forecast);
          const currentHasData = !isEmpty(event.actual) || !isEmpty(event.forecast);
          
          // Decision logic (in order of priority):
          // 1. Prefer event with actual/forecast data
          // 2. Prefer High impact over Medium/Low
          // 3. Prefer ForexFactory as more reliable source
          const shouldReplace = 
            (currentHasData && !existingHasData) ||
            (event.impact === 'High' && existing.impact !== 'High') ||
            (event.source === 'ForexFactory' && existing.source !== 'ForexFactory');
          
          if (shouldReplace) {
            deduplicationMap.set(key, event);
            console.log(`[EventAggregation] Replaced duplicate: ${existing.title} (${existing.source}) → ${event.title} (${event.source})`);
          } else {
            console.log(`[EventAggregation] Kept existing: ${existing.title} (${existing.source}), skipped: ${event.title} (${event.source})`);
          }
        }
      }
    }
    
    const deduplicatedEvents = Array.from(deduplicationMap.values());
    console.log(`[EventAggregation] ${userInfo}Total after deduplication: ${deduplicatedEvents.length} events`);
    
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
      ? calendarService.getEventsForTomorrow().catch(() => [])
      : calendarService.getEventsForToday().catch(() => []);
  }
}
