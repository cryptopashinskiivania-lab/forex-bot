/**
 * Test: fetch ForexFactory calendar for tomorrow and log all events (including filtered ones)
 * Run: npx ts-node scripts/test-tomorrow.ts
 */
import { CalendarService } from '../src/services/CalendarService';
import { toZonedTime } from 'date-fns-tz';
import { format, parseISO } from 'date-fns';

async function main() {
  const service = new CalendarService();
  
  try {
    console.log('Fetching https://www.forexfactory.com/calendar?day=tomorrow ...\n');
    
    // Get all events for tomorrow
    const events = await service.getEventsForTomorrow();
    
    console.log(`Found ${events.length} events (after filtering):\n`);
    
    events.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.impact} | ${e.title}`);
      console.log(`   Time from ForexFactory (NY): ${e.time}`);
      
      if (e.timeISO) {
        const utcDate = parseISO(e.timeISO);
        const nyTime = toZonedTime(utcDate, 'America/New_York');
        const kyivTime = toZonedTime(utcDate, 'Europe/Kyiv');
        
        console.log(`   UTC time (saved to DB): ${e.timeISO}`);
        console.log(`   NY time (for verification): ${format(nyTime, 'HH:mm')}`);
        console.log(`   Kyiv time (shown to user): ${format(kyivTime, 'HH:mm')}`);
      } else {
        console.log(`   ⚠️  No valid time parsed (All Day/Tentative)`);
      }
      
      console.log(`   Forecast: ${e.forecast} | Previous: ${e.previous} | Actual: ${e.actual}`);
      console.log(`   Is Result: ${e.isResult}\n`);
    });
    
    console.log('\n=== Summary ===');
    console.log(`Total events found: ${events.length}`);
  } catch (err) {
    console.error('Error:', err);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
