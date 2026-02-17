/**
 * Test Myfxbook parsing
 */
import { MyfxbookRssService } from '../src/services/MyfxbookRssService';
import { toZonedTime } from 'date-fns-tz';
import { format, parseISO } from 'date-fns';

async function main() {
  const service = new MyfxbookRssService();
  
  try {
    console.log('Fetching Myfxbook calendar for today...\n');
    const events = await service.getEventsForToday();
    
    console.log(`Found ${events.length} events:\n`);
    
    events.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.impact} | ${e.title}`);
      console.log(`   Time: ${e.time}`);
      
      if (e.timeISO) {
        const utcDate = parseISO(e.timeISO);
        const kyivTime = toZonedTime(utcDate, 'Europe/Kyiv');
        console.log(`   Kyiv time: ${format(kyivTime, 'HH:mm')}`);
      }
      
      console.log(`   Forecast: ${e.forecast} | Previous: ${e.previous} | Actual: ${e.actual}`);
      console.log(`   Source: ${e.source}\n`);
    });
  } finally {
    await service.close();
    console.log('✅ Done');
  }
}

main().catch(console.error);
