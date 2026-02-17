/**
 * Test MyFxBook RSS service: raw, today, tomorrow, cache, performance.
 */
import { MyfxbookRssService } from '../src/services/MyfxbookRssService';
import { toZonedTime } from 'date-fns-tz';
import { format, parseISO } from 'date-fns';

async function main() {
  const service = new MyfxbookRssService();

  console.log('=== MyFxBook RSS Service Test ===\n');

  try {
    // 1. getEventsForTodayRaw
    let t0 = Date.now();
    const raw = await service.getEventsForTodayRaw();
    const rawMs = Date.now() - t0;
    console.log(`1. getEventsForTodayRaw(): ${raw.length} events in ${rawMs}ms\n`);

    // 2. getEventsForToday (with TZ)
    t0 = Date.now();
    const today = await service.getEventsForToday('Europe/Kyiv');
    const todayMs = Date.now() - t0;
    console.log(`2. getEventsForToday('Europe/Kyiv'): ${today.length} events in ${todayMs}ms (cached)\n`);

    // 3. getEventsForTomorrow
    t0 = Date.now();
    const tomorrow = await service.getEventsForTomorrow('Europe/Kyiv');
    const tomorrowMs = Date.now() - t0;
    console.log(`3. getEventsForTomorrow('Europe/Kyiv'): ${tomorrow.length} events in ${tomorrowMs}ms (cached)\n`);

    // 4. Cache: second call should be instant
    t0 = Date.now();
    await service.getEventsForTodayRaw();
    const cachedMs = Date.now() - t0;
    console.log(`4. getEventsForTodayRaw() (2nd call, cache): ${cachedMs}ms\n`);

    // 5. Sample events with all fields
    const sample = raw.slice(0, 5);
    console.log('5. Sample events (first 5):');
    sample.forEach((e, i) => {
      console.log(`   ${i + 1}. [${e.currency}] ${e.impact} | ${e.title}`);
      console.log(`      time: ${e.time} | timeISO: ${e.timeISO ?? '—'}`);
      if (e.timeISO) {
        const utcDate = parseISO(e.timeISO);
        const kyivTime = toZonedTime(utcDate, 'Europe/Kyiv');
        console.log(`      Kyiv: ${format(kyivTime, 'HH:mm')}`);
      }
      console.log(`      forecast: ${e.forecast} | previous: ${e.previous} | actual: ${e.actual}`);
      console.log(`      source: ${e.source} | isResult: ${e.isResult}`);
      console.log('');
    });

    console.log('=== Summary ===');
    console.log(`First fetch: ${rawMs}ms (target < 1000ms)`);
    console.log(`Cached fetch: ${cachedMs}ms (target instant)`);
    console.log(`Raw today: ${raw.length} | Today (Kyiv): ${today.length} | Tomorrow (Kyiv): ${tomorrow.length}`);
    console.log('\nDone.');
  } finally {
    await service.close();
  }
}

main().catch(console.error);
