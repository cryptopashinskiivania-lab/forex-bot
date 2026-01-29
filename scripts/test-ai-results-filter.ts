/**
 * Test script to verify AI Results filtering (forecast + actual required)
 */

import { DataQualityService } from '../src/services/DataQualityService';
import { CalendarEvent } from '../src/services/CalendarService';

console.log('=== Testing AI Results Filter (Forecast + Actual) ===\n');

const dataQualityService = new DataQualityService();

// Create test events with different data combinations
const testEvents: CalendarEvent[] = [
  // Case 1: Has BOTH forecast AND actual - SHOULD PASS
  {
    title: 'GDP q/q',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-29T13:30:00.000Z',
    impact: 'High',
    forecast: '2.5%',
    previous: '2.3%',
    actual: '2.6%',
    source: 'ForexFactory',
    isResult: true,
  },
  
  // Case 2: Has actual but NO forecast - SHOULD SKIP
  {
    title: 'CPI y/y',
    currency: 'EUR',
    time: '10:00am',
    timeISO: '2026-01-29T15:00:00.000Z',
    impact: 'High',
    forecast: '—',
    previous: '2.3%',
    actual: '2.5%',
    source: 'ForexFactory',
    isResult: true,
  },
  
  // Case 3: Has forecast but NO actual - SHOULD SKIP
  {
    title: 'Unemployment Rate',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-29T13:30:00.000Z',
    impact: 'High',
    forecast: '4.0%',
    previous: '4.1%',
    actual: '—',
    source: 'Myfxbook',
    isResult: false,
  },
  
  // Case 4: Has BOTH but both are empty - SHOULD SKIP
  {
    title: 'Core CPI',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-29T13:30:00.000Z',
    impact: 'High',
    forecast: '-',
    previous: '2.0%',
    actual: '',
    source: 'ForexFactory',
    isResult: false,
  },
  
  // Case 5: Has BOTH - SHOULD PASS
  {
    title: 'Non-Farm Payrolls',
    currency: 'USD',
    time: '8:30am',
    timeISO: '2026-01-29T13:30:00.000Z',
    impact: 'High',
    forecast: '150K',
    previous: '160K',
    actual: '145K',
    source: 'ForexFactory',
    isResult: true,
  },
];

console.log('Test Events:');
testEvents.forEach((event, i) => {
  const hasForecast = event.forecast && event.forecast.trim() && event.forecast !== '—' && event.forecast !== '-';
  const hasActual = event.actual && event.actual.trim() && event.actual !== '—' && event.actual !== '-';
  console.log(`${i + 1}. ${event.title} (${event.currency})`);
  console.log(`   Forecast: ${event.forecast} ${hasForecast ? '✓' : '✗'}`);
  console.log(`   Actual: ${event.actual} ${hasActual ? '✓' : '✗'}`);
});

console.log('\n--- Running filterForDelivery (mode: ai_results) ---\n');

const { deliver, skipped } = dataQualityService.filterForDelivery(
  testEvents,
  { mode: 'ai_results', nowUtc: new Date('2026-01-29T16:00:00.000Z') }
);

console.log(`✅ Events to deliver: ${deliver.length}`);
deliver.forEach((event, i) => {
  console.log(`${i + 1}. ${event.title} - Forecast: ${event.forecast}, Actual: ${event.actual}`);
});

console.log(`\n⚠️  Events skipped: ${skipped.length}`);
skipped.forEach((issue, i) => {
  console.log(`${i + 1}. ${issue.message}`);
  console.log(`   Type: ${issue.type}`);
  if (issue.details && typeof issue.details === 'object' && 'hasActual' in issue.details) {
    console.log(`   Has Actual: ${(issue.details as any).hasActual}`);
    console.log(`   Has Forecast: ${(issue.details as any).hasForecast}`);
  }
});

console.log('\n=== Test Expectations ===');
console.log('Expected to DELIVER: 2 events (GDP q/q, Non-Farm Payrolls)');
console.log('Expected to SKIP: 3 events (CPI y/y, Unemployment Rate, Core CPI)');
console.log('');
console.log(`Actual DELIVER: ${deliver.length} events`);
console.log(`Actual SKIP: ${skipped.length} events`);

if (deliver.length === 2 && skipped.length === 3) {
  console.log('\n✅ TEST PASSED - Correct filtering for AI Results');
  
  // Verify that skipped events have the correct reasons
  const missingDataIssues = skipped.filter(s => s.type === 'MISSING_REQUIRED_FIELD');
  if (missingDataIssues.length === 3) {
    console.log('✅ All skipped events have MISSING_REQUIRED_FIELD type');
  } else {
    console.log(`⚠️  Expected 3 MISSING_REQUIRED_FIELD issues, got ${missingDataIssues.length}`);
  }
} else {
  console.log('\n❌ TEST FAILED');
}
