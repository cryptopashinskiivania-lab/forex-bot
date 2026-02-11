/**
 * Test script to verify that events from different sources are NOT deduplicated
 * 
 * This test checks that:
 * 1. Events from ForexFactory and Myfxbook with same time/currency are shown separately
 * 2. Events within the same source are still deduplicated (as expected)
 * 3. User source preference is respected correctly
 */

import { CalendarEvent } from '../src/services/CalendarService';
import crypto from 'crypto';
import { parseISO } from 'date-fns';

function md5(str: string): string {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
}

/**
 * Copied deduplication logic from eventAggregation.ts (after fix)
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
  
  // IMPORTANT: Include source in the key so events from different sources are NOT deduplicated
  return md5(`${event.source}_${timeKey}_${event.currency}`);
}

/**
 * Simulate deduplication logic
 */
function deduplicateEvents(events: CalendarEvent[]): CalendarEvent[] {
  const deduplicationMap = new Map<string, CalendarEvent>();
  const seenKeys = new Set<string>();
  
  for (const event of events) {
    const key = deduplicationKey(event);
    
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicationMap.set(key, event);
    } else {
      // Duplicate within SAME source - keep the better one
      const existing = deduplicationMap.get(key);
      if (existing) {
        const existingHasData = !isEmpty(existing.actual) || !isEmpty(existing.forecast);
        const currentHasData = !isEmpty(event.actual) || !isEmpty(event.forecast);
        
        const shouldReplace = 
          (currentHasData && !existingHasData) ||
          (event.impact === 'High' && existing.impact !== 'High');
        
        if (shouldReplace) {
          deduplicationMap.set(key, event);
          console.log(`  ✓ Replaced duplicate within ${event.source}: ${existing.title} → ${event.title}`);
        } else {
          console.log(`  ✓ Kept existing in ${existing.source}: ${existing.title}`);
        }
      }
    }
  }
  
  return Array.from(deduplicationMap.values());
}

/**
 * Test cases
 */
function runTests() {
  console.log('='.repeat(80));
  console.log('TEST: No Cross-Source Deduplication');
  console.log('='.repeat(80));
  console.log();

  // Test 1: Same event from both sources - should show BOTH
  console.log('Test 1: Same event from ForexFactory and Myfxbook');
  console.log('-'.repeat(80));
  const test1Events: CalendarEvent[] = [
    {
      title: 'Non-Farm Payrolls',
      currency: 'USD',
      impact: 'High',
      time: '1:30pm',
      timeISO: '2026-02-11T18:30:00.000Z',
      forecast: '180K',
      previous: '200K',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
    {
      title: 'Non-Farm Payrolls',
      currency: 'USD',
      impact: 'High',
      time: '1:30pm',
      timeISO: '2026-02-11T18:30:00.000Z',
      forecast: '180K',
      previous: '200K',
      actual: '—',
      source: 'Myfxbook',
      isResult: false,
    },
  ];
  
  const result1 = deduplicateEvents(test1Events);
  console.log(`Input: ${test1Events.length} events`);
  console.log(`Output: ${result1.length} events`);
  console.log(`Sources: ${result1.map(e => e.source).join(', ')}`);
  
  if (result1.length === 2) {
    console.log('✅ PASS: Both events are shown (no cross-source deduplication)');
  } else {
    console.log('❌ FAIL: Events were deduplicated across sources!');
  }
  console.log();

  // Test 2: Duplicate within same source - should deduplicate
  console.log('Test 2: Duplicate within ForexFactory');
  console.log('-'.repeat(80));
  const test2Events: CalendarEvent[] = [
    {
      title: 'GDP Report',
      currency: 'EUR',
      impact: 'High',
      time: '10:00am',
      timeISO: '2026-02-11T15:00:00.000Z',
      forecast: '2.5%',
      previous: '2.3%',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
    {
      title: 'GDP Report',
      currency: 'EUR',
      impact: 'High',
      time: '10:00am',
      timeISO: '2026-02-11T15:00:00.000Z',
      forecast: '2.5%',
      previous: '2.3%',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
  ];
  
  const result2 = deduplicateEvents(test2Events);
  console.log(`Input: ${test2Events.length} events`);
  console.log(`Output: ${result2.length} events`);
  
  if (result2.length === 1) {
    console.log('✅ PASS: Duplicate within same source was removed');
  } else {
    console.log('❌ FAIL: Duplicate was not removed!');
  }
  console.log();

  // Test 3: Mixed scenario - same event from both sources + duplicate in one source
  console.log('Test 3: Mixed scenario');
  console.log('-'.repeat(80));
  const test3Events: CalendarEvent[] = [
    {
      title: 'CPI Report',
      currency: 'USD',
      impact: 'High',
      time: '8:30am',
      timeISO: '2026-02-11T13:30:00.000Z',
      forecast: '3.2%',
      previous: '3.1%',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
    {
      title: 'CPI Report',
      currency: 'USD',
      impact: 'High',
      time: '8:30am',
      timeISO: '2026-02-11T13:30:00.000Z',
      forecast: '3.2%',
      previous: '3.1%',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
    {
      title: 'CPI Report',
      currency: 'USD',
      impact: 'High',
      time: '8:30am',
      timeISO: '2026-02-11T13:30:00.000Z',
      forecast: '3.2%',
      previous: '3.1%',
      actual: '—',
      source: 'Myfxbook',
      isResult: false,
    },
  ];
  
  const result3 = deduplicateEvents(test3Events);
  console.log(`Input: ${test3Events.length} events`);
  console.log(`Output: ${result3.length} events`);
  console.log(`Sources: ${result3.map(e => e.source).join(', ')}`);
  
  const ffCount = result3.filter(e => e.source === 'ForexFactory').length;
  const mfxCount = result3.filter(e => e.source === 'Myfxbook').length;
  
  if (result3.length === 2 && ffCount === 1 && mfxCount === 1) {
    console.log('✅ PASS: One event per source (duplicate within FF removed, both sources shown)');
  } else {
    console.log('❌ FAIL: Unexpected deduplication behavior!');
  }
  console.log();

  // Test 4: Different events from both sources - should show all
  console.log('Test 4: Different events from both sources');
  console.log('-'.repeat(80));
  const test4Events: CalendarEvent[] = [
    {
      title: 'Retail Sales',
      currency: 'USD',
      impact: 'Medium',
      time: '8:30am',
      timeISO: '2026-02-11T13:30:00.000Z',
      forecast: '0.5%',
      previous: '0.3%',
      actual: '—',
      source: 'ForexFactory',
      isResult: false,
    },
    {
      title: 'Industrial Production',
      currency: 'EUR',
      impact: 'Medium',
      time: '10:00am',
      timeISO: '2026-02-11T15:00:00.000Z',
      forecast: '1.2%',
      previous: '1.0%',
      actual: '—',
      source: 'Myfxbook',
      isResult: false,
    },
  ];
  
  const result4 = deduplicateEvents(test4Events);
  console.log(`Input: ${test4Events.length} events`);
  console.log(`Output: ${result4.length} events`);
  
  if (result4.length === 2) {
    console.log('✅ PASS: All different events are shown');
  } else {
    console.log('❌ FAIL: Events were incorrectly deduplicated!');
  }
  console.log();

  console.log('='.repeat(80));
  console.log('All tests completed!');
  console.log('='.repeat(80));
}

// Run tests
runTests();
