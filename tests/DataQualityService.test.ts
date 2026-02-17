/**
 * Unit tests for DataQualityService
 * Run with: npx ts-node tests/DataQualityService.test.ts
 */

import { DataQualityService } from '../src/services/DataQualityService';
import { CalendarEvent } from '../src/types/calendar';

// Simple test framework (no external dependencies)
class TestRunner {
  private passed = 0;
  private failed = 0;
  private tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

  test(name: string, fn: () => void | Promise<void>) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('\n🧪 Running DataQualityService Tests\n');
    console.log('='.repeat(60));

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        this.passed++;
        console.log(`✅ ${name}`);
      } catch (error) {
        this.failed++;
        console.log(`❌ ${name}`);
        console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('='.repeat(60));
    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed\n`);

    if (this.failed > 0) {
      process.exit(1);
    }
  }
}

// Assertion helpers
function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toEqual(expected: T) {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr}, got ${actualStr}`);
      }
    },
    toContain(item: unknown) {
      if (!Array.isArray(actual)) {
        throw new Error('toContain can only be used with arrays');
      }
      if (!actual.includes(item as never)) {
        throw new Error(`Expected array to contain ${item}`);
      }
    },
    toBeGreaterThan(value: number) {
      if (typeof actual !== 'number') {
        throw new Error('toBeGreaterThan can only be used with numbers');
      }
      if (actual <= value) {
        throw new Error(`Expected ${actual} to be greater than ${value}`);
      }
    },
  };
}

// Test suite
const runner = new TestRunner();

// Test 1: Filter past events
runner.test('should filter past events', () => {
  const dqs = new DataQualityService();
  const pastEvent: CalendarEvent = {
    title: 'Past Event',
    time: '10:00',
    timeISO: '2026-01-28T10:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { deliver, skipped } = dqs.filterForDelivery([pastEvent], {
    mode: 'general',
    nowUtc: new Date('2026-01-29T12:00:00Z'),
    forScheduler: true,
  });

  expect(deliver.length).toBe(0);
  expect(skipped.length).toBe(1);
  expect(skipped[0].type).toBe('PAST_TOO_FAR');
});

// Test 2: Future events should be delivered
runner.test('should deliver future events', () => {
  const dqs = new DataQualityService();
  const futureEvent: CalendarEvent = {
    title: 'Future Event',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'EUR',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { deliver, skipped } = dqs.filterForDelivery([futureEvent], {
    mode: 'general',
    nowUtc: new Date('2026-01-29T12:00:00Z'),
  });

  expect(deliver.length).toBe(1);
  expect(skipped.length).toBe(0);
  expect(deliver[0].title).toBe('Future Event');
});

// Test 3: Events without timeISO should be skipped (except AI Results mode)
runner.test('should skip events without timeISO in general mode', () => {
  const dqs = new DataQualityService();
  const eventWithoutTime: CalendarEvent = {
    title: 'Event Without Time',
    time: '14:00',
    currency: 'GBP',
    impact: 'Medium',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { deliver, skipped } = dqs.filterForDelivery([eventWithoutTime], {
    mode: 'general',
  });

  expect(deliver.length).toBe(0);
  expect(skipped.length).toBe(1);
  expect(skipped[0].type).toBe('NO_TIME');
});

// Test 4: AI Results mode requires both actual and forecast
runner.test('should skip events without actual/forecast in AI Results mode', () => {
  const dqs = new DataQualityService();
  const eventWithoutActual: CalendarEvent = {
    title: 'Event Without Actual',
    time: '14:00',
    timeISO: '2026-01-28T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '5.2%',
    previous: '',
    actual: '',
    isResult: true,
  };

  const { deliver, skipped } = dqs.filterForDelivery([eventWithoutActual], {
    mode: 'ai_results',
  });

  expect(deliver.length).toBe(0);
  expect(skipped.length).toBe(1);
  expect(skipped[0].type).toBe('MISSING_REQUIRED_FIELD');
});

// Test 5: AI Results mode accepts valid events
runner.test('should deliver events with actual and forecast in AI Results mode', () => {
  const dqs = new DataQualityService();
  const validEvent: CalendarEvent = {
    title: 'Complete Event',
    time: '14:00',
    timeISO: '2026-01-28T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '5.2%',
    previous: '',
    actual: '5.5%',
    isResult: true,
  };

  const { deliver, skipped } = dqs.filterForDelivery([validEvent], {
    mode: 'ai_results',
  });

  expect(deliver.length).toBe(1);
  expect(skipped.length).toBe(0);
});

// Test 6: Check for missing required fields
runner.test('should detect missing required fields', () => {
  const dqs = new DataQualityService();
  const invalidEvent: CalendarEvent = {
    title: '',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { valid, issues } = dqs.checkRawAndNormalize([invalidEvent]);

  expect(valid.length).toBe(0);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0].type).toBe('MISSING_REQUIRED_FIELD');
});

// Test 7: Validate impact values
runner.test('should detect invalid impact values', () => {
  const dqs = new DataQualityService();
  const invalidImpactEvent: CalendarEvent = {
    title: 'Invalid Impact',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'USD',
    impact: 'VeryHigh' as any,
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { valid, issues } = dqs.checkRawAndNormalize([invalidImpactEvent]);

  expect(issues.some(i => i.type === 'INVALID_RANGE')).toBe(true);
});

// Test 8: Detect duplicate events
runner.test('should detect duplicate events', () => {
  const dqs = new DataQualityService();
  const event1: CalendarEvent = {
    title: 'NFP',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };
  const event2: CalendarEvent = {
    title: 'NFP',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { valid, issues } = dqs.checkRawAndNormalize([event1, event2]);

  expect(valid.length).toBe(1);
  expect(issues.some(i => i.type === 'DUPLICATE_EVENT')).toBe(true);
});

// Test 9: Cross-source conflict detection
runner.test('should detect cross-source time conflicts', () => {
  const dqs = new DataQualityService();
  const ffEvent: CalendarEvent = {
    title: 'NFP',
    time: '14:00',
    timeISO: '2026-01-30T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };
  const mfbEvent: CalendarEvent = {
    title: 'NFP',
    time: '14:30',
    timeISO: '2026-01-30T14:30:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'Myfxbook',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const conflicts = dqs.checkCrossSourceConflicts([ffEvent, mfbEvent]);

  expect(conflicts.length).toBeGreaterThan(0);
  expect(conflicts[0].type).toBe('CONFLICT_BETWEEN_SOURCES');
});

// Test 10: AI Forecast mode should only accept future events
runner.test('should filter non-future events in AI Forecast mode', () => {
  const dqs = new DataQualityService();
  const pastEvent: CalendarEvent = {
    title: 'Past Event',
    time: '10:00',
    timeISO: '2026-01-28T10:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { deliver, skipped } = dqs.filterForDelivery([pastEvent], {
    mode: 'ai_forecast',
    nowUtc: new Date('2026-01-29T12:00:00Z'),
  });

  expect(deliver.length).toBe(0);
  expect(skipped.length).toBe(1);
  expect(skipped[0].type).toBe('PAST_TOO_FAR');
});

// Test 10b: /daily mode (forScheduler: false) delivers events up to 24h ago
runner.test('should deliver event 3h ago when forScheduler is false', () => {
  const dqs = new DataQualityService();
  const event3hAgo: CalendarEvent = {
    title: 'Event 3h Ago',
    time: '09:00',
    timeISO: '2026-01-29T09:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { deliver, skipped } = dqs.filterForDelivery([event3hAgo], {
    mode: 'general',
    nowUtc: new Date('2026-01-29T12:00:00Z'),
    forScheduler: false,
  });

  expect(deliver.length).toBe(1);
  expect(skipped.length).toBe(0);
  expect(deliver[0].title).toBe('Event 3h Ago');
});

// Test 11: Check recommended fields
runner.test('should log missing recommended fields', () => {
  const dqs = new DataQualityService();
  const eventWithoutTimeISO: CalendarEvent = {
    title: 'Event Without TimeISO',
    time: '14:00',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { valid, issues } = dqs.checkRawAndNormalize([eventWithoutTimeISO]);

  expect(valid.length).toBe(1);
  expect(issues.some(i => i.type === 'NO_TIME')).toBe(true);
});

// Test 12: Validate time range
runner.test('should detect events too far from now', () => {
  const dqs = new DataQualityService();
  const farFutureEvent: CalendarEvent = {
    title: 'Far Future Event',
    time: '14:00',
    timeISO: '2026-02-10T14:00:00Z',
    currency: 'USD',
    impact: 'High',
    source: 'ForexFactory',
    forecast: '',
    previous: '',
    actual: '',
    isResult: false,
  };

  const { valid, issues } = dqs.checkRawAndNormalize([farFutureEvent]);

  expect(issues.some(i => i.type === 'TIME_INCONSISTENCY')).toBe(true);
});

// Run all tests
runner.run().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
