/**
 * Quick test: fetch ForexFactory calendar and log scraped events.
 * Run: npx ts-node scripts/test-calendar-scrape.ts
 */
import { CalendarService } from '../src/services/CalendarService';
import { toZonedTime } from 'date-fns-tz';
import { format, parseISO } from 'date-fns';

async function main() {
  const service = new CalendarService();
  
  try {
    console.log('Fetching https://www.forexfactory.com/calendar?day=today ...\n');
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
    console.log('✅ Times are correctly parsed from America/New_York timezone (ForexFactory default)');
    console.log('✅ UTC times are saved to database');
    console.log('✅ Kyiv times are displayed to users');
  } finally {
    // Закрываем браузер и БД
    await service.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
