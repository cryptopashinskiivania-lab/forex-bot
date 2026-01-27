/**
 * Test event formatting with source separation
 */
import { CalendarService } from '../src/services/CalendarService';
import { MyfxbookService } from '../src/services/MyfxbookService';

async function main() {
  const calendarService = new CalendarService();
  const myfxbookService = new MyfxbookService();
  
  try {
    console.log('Testing event sources for TOMORROW...\n');
    
    // Fetch from both sources
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      calendarService.getEventsForTomorrow(),
      myfxbookService.getEventsForTomorrow(),
    ]);
    
    console.log(`━━━ ForexFactory sources ━━━`);
    forexFactoryEvents.forEach(e => {
      console.log(`source: "${e.source}" | [${e.currency}] ${e.title}`);
    });
    
    console.log(`\n━━━ Myfxbook sources ━━━`);
    myfxbookEvents.forEach(e => {
      console.log(`source: "${e.source}" | [${e.currency}] ${e.title}`);
    });
    
    // Test filtering
    console.log(`\n━━━ FILTERING TEST ━━━`);
    const allEvents = [...forexFactoryEvents, ...myfxbookEvents];
    
    const ffFiltered = allEvents.filter(e => e.source === 'ForexFactory');
    const mbFiltered = allEvents.filter(e => e.source === 'Myfxbook');
    
    console.log(`\nTotal events: ${allEvents.length}`);
    console.log(`ForexFactory filtered: ${ffFiltered.length}`);
    console.log(`Myfxbook filtered: ${mbFiltered.length}`);
    
  } finally {
    await myfxbookService.close();
    console.log('\n✅ Browser closed');
  }
}

main().catch(console.error);
