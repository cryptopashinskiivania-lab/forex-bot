/**
 * Test script to verify cross-source conflict detection
 */

import { DataQualityService } from '../src/services/DataQualityService';
import { CalendarEvent } from '../src/services/CalendarService';

console.log('=== Testing Cross-Source Conflict Detection ===\n');

const dataQualityService = new DataQualityService();

// Create test events with realistic conflicts
const testEvents: CalendarEvent[] = [
  // Case 1: Same title, different time (15 min difference) - SHOULD DETECT CONFLICT
  {
    title: 'Non-Farm Employment Change',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-30T13:30:00.000Z',
    impact: 'High',
    forecast: '150K',
    previous: '160K',
    actual: '—',
    source: 'ForexFactory',
    isResult: false,
  },
  {
    title: 'Non-Farm Employment Change',
    currency: 'USD',
    time: '8:45am',
    timeISO: '2026-01-30T13:45:00.000Z', // 15 minutes difference
    impact: 'High',
    forecast: '150K',
    previous: '160K',
    actual: '—',
    source: 'Myfxbook',
    isResult: false,
  },
  
  // Case 2: Same title, same time - NO CONFLICT
  {
    title: 'Unemployment Rate',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-30T13:30:00.000Z',
    impact: 'High',
    forecast: '4.0%',
    previous: '4.1%',
    actual: '—',
    source: 'ForexFactory',
    isResult: false,
  },
  {
    title: 'Unemployment Rate',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-30T13:30:00.000Z', // Same time, no conflict
    impact: 'High',
    forecast: '4.0%',
    previous: '4.1%',
    actual: '—',
    source: 'Myfxbook',
    isResult: false,
  },
  
  // Case 3: Similar titles (with suffix), time difference - SHOULD DETECT CONFLICT
  {
    title: 'CPI y/y',
    currency: 'EUR',
    time: '10:00am',
    timeISO: '2026-01-30T15:00:00.000Z',
    impact: 'High',
    forecast: '2.5%',
    previous: '2.3%',
    actual: '—',
    source: 'ForexFactory',
    isResult: false,
  },
  {
    title: 'CPI',
    currency: 'EUR',
    time: '10:10am',
    timeISO: '2026-01-30T15:10:00.000Z', // 10 minutes difference
    impact: 'High',
    forecast: '2.5%',
    previous: '2.3%',
    actual: '—',
    source: 'Myfxbook',
    isResult: false,
  },
  
  // Case 4: Different currencies - NO CONFLICT (even if similar titles)
  {
    title: 'GDP q/q',
    currency: 'USD',
    time: '9:00am',
    timeISO: '2026-01-30T14:00:00.000Z',
    impact: 'High',
    forecast: '2.0%',
    previous: '1.8%',
    actual: '—',
    source: 'ForexFactory',
    isResult: false,
  },
  {
    title: 'GDP q/q',
    currency: 'GBP',
    time: '9:00am',
    timeISO: '2026-01-30T14:00:00.000Z', // Same time but different currency
    impact: 'High',
    forecast: '1.5%',
    previous: '1.3%',
    actual: '—',
    source: 'Myfxbook',
    isResult: false,
  },
];

console.log('Test Events:');
testEvents.forEach((event, i) => {
  console.log(`${i + 1}. [${event.source}] ${event.title} (${event.currency}) - ${event.timeISO}`);
});

console.log('\n--- Running checkCrossSourceConflicts ---\n');

const conflicts = dataQualityService.checkCrossSourceConflicts(testEvents);

if (conflicts.length === 0) {
  console.log('✅ No conflicts detected');
} else {
  console.log(`⚠️  Found ${conflicts.length} conflict(s):\n`);
  conflicts.forEach((conflict, i) => {
    console.log(`${i + 1}. ${conflict.message}`);
    console.log(`   Type: ${conflict.type}`);
    console.log(`   Details:`, JSON.stringify(conflict.details, null, 2));
    console.log('');
  });
}

console.log('\n=== Test Expectations ===');
console.log('Expected: 2 conflicts:');
console.log('  1. Non-Farm Employment Change (15 min time difference)');
console.log('  2. CPI y/y vs CPI (10 min time difference, similarity > 0.7)');
console.log('');
console.log('Expected: 0 conflicts for:');
console.log('  - Unemployment Rate (same time)');
console.log('  - GDP q/q (different currencies)');
console.log('');
console.log(`Actual: ${conflicts.length} conflict(s) found`);

if (conflicts.length === 2) {
  console.log('\n✅ TEST PASSED - Correct number of conflicts detected');
} else if (conflicts.length === 1) {
  console.log('\n⚠️  TEST PARTIAL - Expected 2 conflicts, got 1');
  console.log('   Note: CPI similarity may be < 0.7 threshold');
} else {
  console.log('\n❌ TEST FAILED - Expected 2 conflicts');
}
