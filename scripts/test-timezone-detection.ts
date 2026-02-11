import { CalendarService } from '../src/services/CalendarService';
import type { CalendarEvent } from '../src/services/CalendarService';

async function testTimezoneDetection() {
  console.log('=== ForexFactory Timezone Detection Test ===\n');
  
  const calendarService = new CalendarService();
  
  try {
    console.log('Fetching today\'s events with timezone detection...\n');
    const events: CalendarEvent[] = await calendarService.getEventsForToday();
    
    console.log(`\n✅ Successfully fetched ${events.length} events`);
    
    // Show first 5 USD events to verify time parsing
    const usdEvents = events.filter((e: CalendarEvent) => e.currency === 'USD').slice(0, 5);
    console.log('\n📊 First 5 USD events:');
    usdEvents.forEach((event: CalendarEvent, i: number) => {
      console.log(`${i + 1}. [${event.currency}] ${event.title}`);
      console.log(`   Time: ${event.time}`);
      console.log(`   Time ISO: ${event.timeISO || 'NOT SET'}`);
      console.log(`   Impact: ${event.impact}`);
      console.log('');
    });
    
    // Verify that NFP events have correct time
    const nfpEvent = events.find((e: CalendarEvent) => e.title.includes('Non-Farm Employment'));
    if (nfpEvent) {
      console.log('✅ NFP Event found!');
      console.log(`   Title: ${nfpEvent.title}`);
      console.log(`   Time: ${nfpEvent.time}`);
      console.log(`   Time ISO: ${nfpEvent.timeISO}`);
      
      if (!nfpEvent.timeISO) {
        console.error('❌ ERROR: NFP event has NO timeISO!');
      } else {
        console.log('✅ NFP event has timeISO');
      }
    }
    
    await calendarService.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testTimezoneDetection();
