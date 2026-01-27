/**
 * Test deduplication logic for ForexFactory + Myfxbook
 */
import { CalendarService } from '../src/services/CalendarService';
import { MyfxbookService } from '../src/services/MyfxbookService';

async function main() {
  const calendarService = new CalendarService();
  const myfxbookService = new MyfxbookService();
  
  try {
    console.log('Testing deduplication for TOMORROW...\n');
    
    // Fetch from both sources
    const [forexFactoryEvents, myfxbookEvents] = await Promise.all([
      calendarService.getEventsForTomorrow(),
      myfxbookService.getEventsForTomorrow(),
    ]);
    
    console.log(`━━━ ForexFactory: ${forexFactoryEvents.length} events ━━━`);
    forexFactoryEvents.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.title} at ${e.time}`);
    });
    
    console.log(`\n━━━ Myfxbook: ${myfxbookEvents.length} events ━━━`);
    myfxbookEvents.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.title} at ${e.time}`);
    });
    
    // Check for FOMC events
    console.log('\n━━━ CHECKING FOR FOMC EVENTS ━━━');
    
    const ffFOMC = forexFactoryEvents.filter(e => 
      e.title.includes('Federal Funds Rate') || 
      e.title.includes('FOMC Statement') || 
      e.title.includes('FOMC Press Conference')
    );
    console.log(`\nForexFactory FOMC events: ${ffFOMC.length}`);
    ffFOMC.forEach(e => console.log(`  - ${e.title} at ${e.time}`));
    
    const mbFOMC = myfxbookEvents.filter(e => 
      e.title.includes('Fed Interest Rate') || 
      e.title.includes('Fed Press Conference')
    );
    console.log(`\nMyfxbook Fed events: ${mbFOMC.length}`);
    mbFOMC.forEach(e => console.log(`  - ${e.title} at ${e.time}`));
    
  } finally {
    await myfxbookService.close();
    console.log('\n✅ Browser closed');
  }
}

main().catch(console.error);
