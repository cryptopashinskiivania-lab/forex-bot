/**
 * Tests for eventGrouping.groupEvents (hasResults by actual value).
 */
import { groupEvents, type EventGroup } from '../src/utils/eventGrouping';
import type { CalendarEvent } from '../src/types/calendar';

const baseTime = '2025-06-15T12:30:00.000Z';

function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    title: 'Test',
    currency: 'USD',
    impact: 'High',
    time: '12:30',
    timeISO: baseTime,
    forecast: '1.0',
    previous: '0.9',
    actual: '',
    source: 'ForexFactory',
    isResult: false,
    ...overrides,
  };
}

function isEventGroup(item: unknown): item is EventGroup {
  return typeof item === 'object' && item !== null && 'events' in item && 'hasResults' in item;
}

console.log('\n🧪 Running eventGrouping Tests\n');
console.log('============================================================');

// Group of 3 events: one with real actual, others placeholder → hasResults should be true
const eventsWithOneActual: CalendarEvent[] = [
  makeEvent({ title: 'A', actual: '', isResult: false }),
  makeEvent({ title: 'B', actual: 'PENDING', isResult: false }),
  makeEvent({ title: 'C', actual: '1.2', isResult: false }),
];
const result1 = groupEvents(eventsWithOneActual);
const group1 = result1.find(isEventGroup);
if (group1 && group1.hasResults) {
  console.log('✅ hasResults = true when at least one event has non-placeholder actual');
} else {
  console.error('❌ expected hasResults = true for group with one actual "1.2", got', group1?.hasResults);
  process.exit(1);
}

// Group of 3 events: all placeholders → hasResults should be false
const eventsAllPlaceholder: CalendarEvent[] = [
  makeEvent({ title: 'A', actual: '', isResult: false }),
  makeEvent({ title: 'B', actual: 'PENDING', isResult: false }),
  makeEvent({ title: 'C', actual: '—', isResult: false }),
];
const result2 = groupEvents(eventsAllPlaceholder);
const group2 = result2.find(isEventGroup);
if (group2 && !group2.hasResults) {
  console.log('✅ hasResults = false when all events have placeholder actual');
} else {
  console.error('❌ expected hasResults = false for group with only placeholders, got', group2?.hasResults);
  process.exit(1);
}

console.log('============================================================');
console.log('\n📊 Results: 2 passed, 0 failed\n');
