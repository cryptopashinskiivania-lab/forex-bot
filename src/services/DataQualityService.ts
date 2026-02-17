/**
 * DataQualityService - Module for data quality control
 * 
 * Purpose: Validate and normalize economic events before saving to DB and before sending to users.
 * This ensures high quality and reliability of output data.
 */

import crypto from 'crypto';
import { parseISO } from 'date-fns';
import { CalendarEvent } from '../types/calendar';
import {
  DataIssue,
  DataIssueType,
  ValidationResult,
  FilterResult,
  AiQualitySummary,
} from '../types/DataQuality';
import { isPlaceholderActual } from '../utils/calendarValue';

/**
 * Constants for validation rules
 */
const VALIDATION_CONFIG = {
  // Time window for events: events should be within ±2 days from now
  MAX_DAYS_FROM_NOW: 2,
  // Past threshold for scheduler: don't notify about events older than this (minutes)
  PAST_THRESHOLD_SCHEDULER_MINUTES: 2 * 60, // 2 hours
  // Past threshold for /daily, /tomorrow: show events up to this old (minutes)
  PAST_THRESHOLD_DAILY_MINUTES: 24 * 60, // 24 hours
  // Valid impact values
  VALID_IMPACTS: ['High', 'Medium', 'Low'] as const,
  // Required fields for an event
  REQUIRED_FIELDS: ['title', 'currency', 'source', 'impact'] as const,
  // Recommended fields (not critical but should be logged if missing)
  RECOMMENDED_FIELDS: ['timeISO'] as const,
};

/**
 * Generate unique event ID based on key properties
 */
function generateEventId(event: CalendarEvent): string {
  const key = `${event.source}_${event.currency}_${event.title}_${event.timeISO || event.time}`;
  return crypto.createHash('md5').update(key, 'utf8').digest('hex');
}

/**
 * Check if a string field is empty or invalid
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return !trimmed || trimmed === '—' || trimmed === '-';
  }
  return false;
}

/**
 * Calculate similarity between two event titles (enhanced approach)
 * Handles abbreviations and substring matching
 */
function titleSimilarity(title1: string, title2: string): number {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t1 = clean(title1);
  const t2 = clean(title2);
  
  if (t1 === t2) return 1.0;
  
  // Check if one contains the other (for "NFP" vs "NFP Report" or abbreviations)
  if (t1.includes(t2) || t2.includes(t1)) {
    const longer = t1.length > t2.length ? t1 : t2;
    const shorter = t1.length > t2.length ? t2 : t1;
    return shorter.length / longer.length; // e.g., 0.3 for "nfp" vs "nonfarmPayrolls"
  }
  
  // Simple character overlap for different titles
  const longer = t1.length > t2.length ? t1 : t2;
  const shorter = t1.length > t2.length ? t2 : t1;
  
  if (longer.length === 0) return 1.0;
  
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer[i] === shorter[i]) matches++;
  }
  
  return matches / longer.length;
}

export class DataQualityService {
  /**
   * Check raw events and normalize them before saving to database
   * 
   * @param events - Array of freshly parsed events
   * @returns Object with valid events and issues found
   */
  checkRawAndNormalize(events: CalendarEvent[]): ValidationResult<CalendarEvent> {
    const valid: CalendarEvent[] = [];
    const issues: DataIssue[] = [];
    const seenEvents = new Map<string, CalendarEvent>();
    
    console.log(`[DataQualityService] Starting validation of ${events.length} events`);
    
    for (const event of events) {
      const eventId = generateEventId(event);
      const eventIssues: DataIssue[] = [];
      
      // 1. Check required fields
      const missingFields: string[] = [];
      
      if (isEmpty(event.title)) missingFields.push('title');
      if (isEmpty(event.currency)) missingFields.push('currency');
      if (isEmpty(event.source)) missingFields.push('source');
      if (isEmpty(event.impact)) missingFields.push('impact');
      
      if (missingFields.length > 0) {
        eventIssues.push({
          eventId,
          source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
          type: 'MISSING_REQUIRED_FIELD',
          message: `Missing required fields: ${missingFields.join(', ')}`,
          details: { missingFields, event },
        });
      }
      
      // 2. Validate impact value
      if (!isEmpty(event.impact) && !VALIDATION_CONFIG.VALID_IMPACTS.includes(event.impact)) {
        eventIssues.push({
          eventId,
          source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
          type: 'INVALID_RANGE',
          message: `Invalid impact value: ${event.impact}`,
          details: { impact: event.impact, validValues: VALIDATION_CONFIG.VALID_IMPACTS },
        });
      }
      
      // 3. Check recommended fields (timeISO)
      if (!event.timeISO) {
        eventIssues.push({
          eventId,
          source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
          type: 'NO_TIME',
          message: `Event is missing timeISO (recommended field)`,
          details: { event },
        });
        // Don't block event, but log the issue
      }
      
      // 4. Validate time range (if timeISO exists)
      if (event.timeISO) {
        try {
          const eventTime = parseISO(event.timeISO);
          const now = new Date();
          const diffDays = Math.abs((eventTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          
          if (diffDays > VALIDATION_CONFIG.MAX_DAYS_FROM_NOW) {
            eventIssues.push({
              eventId,
              source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
              type: 'TIME_INCONSISTENCY',
              message: `Event time is too far from now: ${diffDays.toFixed(1)} days`,
              details: { timeISO: event.timeISO, diffDays },
            });
          }
        } catch (error) {
          eventIssues.push({
            eventId,
            source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
            type: 'TIME_INCONSISTENCY',
            message: `Failed to parse timeISO: ${event.timeISO}`,
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      
      // 5. Check for duplicates within same source
      const deduplicationKey = this.createDeduplicationKey(event);
      const existingEvent = seenEvents.get(deduplicationKey);
      
      if (existingEvent) {
        eventIssues.push({
          eventId,
          source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
          type: 'DUPLICATE_EVENT',
          message: `Duplicate event detected: ${event.title}`,
          details: {
            existingEvent: {
              title: existingEvent.title,
              time: existingEvent.timeISO || existingEvent.time,
            },
            currentEvent: {
              title: event.title,
              time: event.timeISO || event.time,
            },
          },
        });
        // Add issues before skipping
        issues.push(...eventIssues);
        // Skip this duplicate
        continue;
      }
      
      // If there are critical issues (missing required fields), don't include event
      const hasCriticalIssues = eventIssues.some(
        issue => issue.type === 'MISSING_REQUIRED_FIELD'
      );
      
      if (!hasCriticalIssues) {
        valid.push(event);
        seenEvents.set(deduplicationKey, event);
      }
      
      // Add all issues to the issues array
      issues.push(...eventIssues);
    }
    
    console.log(`[DataQualityService] Validation complete: ${valid.length} valid, ${issues.length} issues found`);
    
    // Log issue summary
    if (issues.length > 0) {
      const issueSummary = issues.reduce((acc, issue) => {
        acc[issue.type] = (acc[issue.type] || 0) + 1;
        return acc;
      }, {} as Record<DataIssueType, number>);
      
      console.log('[DataQualityService] Issue summary:', issueSummary);
    }
    
    return { valid, issues };
  }
  
  /**
   * Check for conflicts between different sources (e.g., ForexFactory vs Myfxbook)
   * 
   * @param allEvents - Events from all sources
   * @returns Issues found (conflicts between sources)
   */
  checkCrossSourceConflicts(allEvents: CalendarEvent[]): DataIssue[] {
    const conflicts: DataIssue[] = [];
    const eventsByKey = new Map<string, CalendarEvent[]>();
    
    // Group events by approximate key (currency + similar title)
    for (const event of allEvents) {
      const key = `${event.currency}`;
      if (!eventsByKey.has(key)) {
        eventsByKey.set(key, []);
      }
      eventsByKey.get(key)!.push(event);
    }
    
    // Check for conflicts within each group
    for (const [key, events] of eventsByKey.entries()) {
      if (events.length < 2) continue;
      
      // Compare each pair of events
      for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
          const event1 = events[i];
          const event2 = events[j];
          
          // Skip if from same source
          if (event1.source === event2.source) continue;
          
          // Check if titles are similar
          const similarity = titleSimilarity(event1.title, event2.title);
          
          if (similarity > 0.7) {
            // Check if times differ significantly
            if (event1.timeISO && event2.timeISO) {
              try {
                const time1 = parseISO(event1.timeISO);
                const time2 = parseISO(event2.timeISO);
                const diffMinutes = Math.abs((time1.getTime() - time2.getTime()) / (1000 * 60));
                
                if (diffMinutes > 5) {
                  conflicts.push({
                    source: 'Merge',
                    type: 'CONFLICT_BETWEEN_SOURCES',
                    message: `Time conflict between sources: ${event1.source} vs ${event2.source} for "${event1.title}"`,
                    details: {
                      event1: {
                        source: event1.source,
                        title: event1.title,
                        timeISO: event1.timeISO,
                      },
                      event2: {
                        source: event2.source,
                        title: event2.title,
                        timeISO: event2.timeISO,
                      },
                      diffMinutes,
                    },
                  });
                }
              } catch (error) {
                // Ignore parse errors
              }
            }
          }
        }
      }
    }
    
    if (conflicts.length > 0) {
      console.log(`[DataQualityService] Found ${conflicts.length} cross-source conflicts`);
    }
    
    return conflicts;
  }
  
  /**
   * Filter events for delivery (before sending to users or to AI)
   * 
   * @param events - Events to filter
   * @param options - Filter options
   * @param options.forScheduler - If true (scheduler): drop events older than 2h. If false (/daily, /tomorrow): keep events up to 24h old.
   * @returns Object with events to deliver and skipped events
   */
  filterForDelivery(
    events: CalendarEvent[],
    options: {
      mode?: 'reminder' | 'ai_forecast' | 'ai_results' | 'general';
      nowUtc?: Date;
      /** true = scheduler (2h past cutoff), false = /daily /tomorrow (24h past cutoff). Only applies when mode is 'general'. */
      forScheduler?: boolean;
    } = {}
  ): FilterResult<CalendarEvent> {
    const { mode = 'general', nowUtc = new Date(), forScheduler = true } = options;
    const deliver: CalendarEvent[] = [];
    const skipped: DataIssue[] = [];

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[DataQualityService] Filtering ${events.length} events for delivery (mode: ${mode})`);
    }

    for (const event of events) {
      const eventId = generateEventId(event);
      let shouldSkip = false;
      
      // 1. Skip events without time (unless it's a special case)
      if (!event.timeISO) {
        // Allow events without time for AI Results mode (if they have real actual data, not PENDING)
        const hasRealActualForTime = typeof event.actual === 'string' && !isEmpty(event.actual) && !isPlaceholderActual(event.actual);
        if (mode === 'ai_results' && hasRealActualForTime) {
          // OK to include
        } else {
          const issue = {
            eventId,
            source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
            type: 'NO_TIME' as const,
            message: `Event has no valid time: ${event.title}`,
            details: { event },
          };
          skipped.push(issue);
          console.log(`[DataQualityService] Filtered out (NO_TIME): ${event.currency} "${event.title}" - ${issue.message}`);
          shouldSkip = true;
        }
      }
      
      // 2. Check for past events (except for AI Results and except events with result — we need those for "result" notifications)
      if (!shouldSkip && event.timeISO && mode !== 'ai_results') {
        try {
          const eventTime = parseISO(event.timeISO);
          const diffMinutes = (nowUtc.getTime() - eventTime.getTime()) / (1000 * 60);

          const hasRealActual =
            typeof event.actual === 'string' &&
            !isEmpty(event.actual) &&
            !isPlaceholderActual(event.actual);

          const pastThresholdMinutes =
            mode === 'general'
              ? forScheduler
                ? VALIDATION_CONFIG.PAST_THRESHOLD_SCHEDULER_MINUTES
                : VALIDATION_CONFIG.PAST_THRESHOLD_DAILY_MINUTES
              : VALIDATION_CONFIG.PAST_THRESHOLD_SCHEDULER_MINUTES; // non-general modes use scheduler threshold for any past check
          if (diffMinutes > pastThresholdMinutes) {
            // Do not skip past events that have real actual data — scheduler sends them as "result" notification
            if (hasRealActual) {
              // Keep in deliver list for result notification
            } else {
              const issue = {
                eventId,
                source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
                type: 'PAST_TOO_FAR' as const,
                message: `Event is too far in the past: ${diffMinutes.toFixed(0)} minutes ago`,
                details: { timeISO: event.timeISO, diffMinutes },
              };
              skipped.push(issue);
              console.log(`[DataQualityService] Filtered out (PAST_TOO_FAR): ${event.currency} "${event.title}" timeISO=${event.timeISO} - ${diffMinutes.toFixed(0)} min ago`);
              shouldSkip = true;
            }
          }
        } catch (error) {
          // If time parsing fails, skip this check
        }
      }
      
      // 3. Mode-specific filters
      if (!shouldSkip && mode === 'ai_forecast') {
        // For AI Forecast: event should be in the future
        if (event.timeISO) {
          try {
            const eventTime = parseISO(event.timeISO);
            if (eventTime.getTime() <= nowUtc.getTime()) {
              const issue = {
                eventId,
                source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
                type: 'PAST_TOO_FAR' as const,
                message: `Event is not in future (AI Forecast requires future events)`,
                details: { timeISO: event.timeISO },
              };
              skipped.push(issue);
              console.log(`[DataQualityService] Filtered out (not in future, mode=ai_forecast): ${event.currency} "${event.title}" timeISO=${event.timeISO}`);
              shouldSkip = true;
            }
          } catch (error) {
            // Ignore
          }
        }
      }
      
      if (!shouldSkip && mode === 'ai_results') {
        // For AI Results: event should have BOTH actual AND forecast data (PENDING is not real actual)
        const hasRealActual = typeof event.actual === 'string' && !isEmpty(event.actual) && !isPlaceholderActual(event.actual);
        const hasForecast = !isEmpty(event.forecast);
        if (!hasRealActual || !hasForecast) {
          const issue = {
            eventId,
            source: (event.source as 'ForexFactory' | 'Myfxbook') || 'ForexFactory',
            type: 'MISSING_REQUIRED_FIELD' as const,
            message: `Event missing actual or forecast data (AI Results requires both)`,
            details: {
              event,
              hasActual: hasRealActual,
              hasForecast,
            },
          };
          skipped.push(issue);
          console.log(`[DataQualityService] Filtered out (AI Results: missing actual/forecast): ${event.currency} "${event.title}" hasActual=${hasRealActual} hasForecast=${hasForecast}`);
          shouldSkip = true;
        }
      }
      
      // 4. If not skipped, add to deliver list
      if (!shouldSkip) {
        deliver.push(event);
      }
    }

    console.log(`[DataQualityService] Filtering complete: ${deliver.length} to deliver, ${skipped.length} skipped`);

    return { deliver, skipped };
  }

  /**
   * AI Review (placeholder for future implementation)
   * 
   * This method can be enhanced with LLM integration to analyze issues
   * and provide intelligent recommendations for data quality improvement.
   */
  async aiReview(
    events: CalendarEvent[],
    issues: DataIssue[]
  ): Promise<AiQualitySummary> {
    // Placeholder implementation
    console.log('[DataQualityService] AI Review called (not yet implemented)');
    
    const summary: AiQualitySummary = {
      totalEvents: events.length,
      validEvents: events.length - issues.length,
      issues,
      recommendations: [
        'Consider implementing time validation rules',
        'Add cross-source conflict resolution',
        'Enhance duplicate detection algorithm',
      ],
    };
    
    return summary;
  }
  
  /**
   * Create deduplication key for an event
   * Used to detect duplicate events within same source
   */
  private createDeduplicationKey(event: CalendarEvent): string {
    const timeKey = event.timeISO || event.time;
    return `${event.source}_${event.currency}_${event.title}_${timeKey}`;
  }
}
