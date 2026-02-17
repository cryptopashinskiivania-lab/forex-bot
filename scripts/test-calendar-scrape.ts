/**
 * Quick test: fetch ForexFactory calendar (CSV) and log events.
 * Run: npx ts-node scripts/test-calendar-scrape.ts
 */
import { ForexFactoryCsvService } from '../src/services/ForexFactoryCsvService';
import { toZonedTime } from 'date-fns-tz';
import { format, parseISO } from 'date-fns';

async function main() {
  const service = new ForexFactoryCsvService();

  try {
    console.log('Fetching https://nfs.faireconomy.media/ff_calendar_thisweek.csv (today filter)...\n');
    const events = await service.getEventsForToday();
    console.log(`Found ${events.length} events (USD/GBP/EUR/JPY/NZD/CAD/AUD/CHF, High/Medium impact):\n`);
    events.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.impact} | ${e.title}`);
      console.log(`   Time from ForexFactory (NY): ${e.time}`);
      
      if (e.timeISO) {
        const utcDate = parseISO(e.timeISO);
        const kyivTime = toZonedTime(utcDate, 'Europe/Kyiv');
        
        console.log(`   UTC time (saved to DB): ${e.timeISO}`);
        console.log(`   Kyiv time (shown to user): ${format(kyivTime, 'HH:mm')}`);
      } else {
        console.log(`   ⚠️  No valid time parsed (All Day/Tentative)`);
      }
      
      console.log(`   Forecast: ${e.forecast} | Previous: ${e.previous}\n`);
    });
    
    console.log('\n=== Summary ===');
    console.log('✅ CSV parsed; times in America/New_York → UTC');
    console.log('✅ High/Medium impact only; 3-min cache');
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
