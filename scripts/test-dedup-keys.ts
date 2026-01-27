/**
 * Test deduplication keys
 */
import { CalendarService } from '../src/services/CalendarService';
import { MyfxbookService } from '../src/services/MyfxbookService';
import { parseISO } from 'date-fns';
import { createHash } from 'crypto';

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function deduplicationKey(event: any): string {
  let timeKey = event.timeISO || event.time;
  
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const roundedMinutes = Math.floor(eventTime.getMinutes() / 5) * 5;
      const roundedTime = new Date(eventTime);
      roundedTime.setMinutes(roundedMinutes, 0, 0);
      timeKey = roundedTime.toISOString().substring(0, 16);
    } catch {
      // If parsing fails, use original time
    }
  }
  
  return md5(`${timeKey}_${event.currency}`);
}

async function main() {
  const calendarService = new CalendarService();
  const myfxbookService = new MyfxbookService();
  
  try {
    console.log('Testing deduplication keys for TOMORROW...\n');
    
    // Fetch from both sources
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      calendarService.getEventsForTomorrow(),
      myfxbookService.getEventsForTomorrow(),
    ]);
    
    console.log('━━━ ForexFactory Keys ━━━');
    forexFactoryEvents.forEach(e => {
      const key = deduplicationKey(e);
      console.log(`${key} | [${e.currency}] ${e.title}`);
      console.log(`  time: ${e.time}, timeISO: ${e.timeISO}\n`);
    });
    
    console.log('\n━━━ Myfxbook Keys ━━━');
    myfxbookEvents.forEach(e => {
      const key = deduplicationKey(e);
      console.log(`${key} | [${e.currency}] ${e.title}`);
      console.log(`  time: ${e.time}, timeISO: ${e.timeISO}\n`);
    });
    
    // Find matching keys
    const ffKeys = new Set(forexFactoryEvents.map(e => deduplicationKey(e)));
    const mbKeys = new Set(myfxbookEvents.map(e => deduplicationKey(e)));
    
    console.log('\n━━━ MATCHING KEYS (duplicates) ━━━');
    for (const key of ffKeys) {
      if (mbKeys.has(key)) {
        const ffEvent = forexFactoryEvents.find(e => deduplicationKey(e) === key);
        const mbEvent = myfxbookEvents.find(e => deduplicationKey(e) === key);
        console.log(`\nKEY: ${key}`);
        console.log(`  FF: [${ffEvent?.currency}] ${ffEvent?.title} at ${ffEvent?.timeISO}`);
        console.log(`  MB: [${mbEvent?.currency}] ${mbEvent?.title} at ${mbEvent?.timeISO}`);
      }
    }
    
  } finally {
    await myfxbookService.close();
    console.log('\n✅ Browser closed');
  }
}

main().catch(console.error);
