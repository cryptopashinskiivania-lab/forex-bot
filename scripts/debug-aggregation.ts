import { CalendarService } from '../src/services/CalendarService';
import { MyfxbookService } from '../src/services/MyfxbookService';
import { aggregateCoreEvents } from '../src/utils/eventAggregation';
import { database } from '../src/db/database';

async function debugAggregation() {
  console.log('=== Event Aggregation Debug ===\n');
  
  // Create test user with USD, EUR, GBP monitored
  const testUserId = 999999;
  database.registerUser(testUserId, 'test_user', 'Test', 'User');
  database.toggleAsset(testUserId, 'USD');
  database.toggleAsset(testUserId, 'EUR');
  database.toggleAsset(testUserId, 'GBP');
  database.setNewsSource(testUserId, 'Both'); // Use both sources
  
  const calendarService = new CalendarService();
  const myfxbookService = new MyfxbookService();
  
  try {
    console.log('Fetching aggregated events...\n');
    const events = await aggregateCoreEvents(calendarService, myfxbookService, testUserId, false);
    
    console.log(`Total aggregated events: ${events.length}\n`);
    
    // Filter USD events
    const usdEvents = events.filter(e => e.currency === 'USD');
    console.log(`USD events: ${usdEvents.length}\n`);
    
    // Group by source
    const forexFactoryEvents = usdEvents.filter(e => e.source === 'ForexFactory');
    const myfxbookEvents = usdEvents.filter(e => e.source === 'Myfxbook');
    
    console.log(`=== ForexFactory USD Events: ${forexFactoryEvents.length} ===\n`);
    forexFactoryEvents.forEach((e, i) => {
      console.log(`${i + 1}. ${e.title}`);
      console.log(`   Time: "${e.time}"`);
      console.log(`   TimeISO: ${e.timeISO || 'undefined'}`);
      console.log(`   Forecast: ${e.forecast}`);
      console.log('');
    });
    
    console.log(`\n=== Myfxbook USD Events: ${myfxbookEvents.length} ===\n`);
    myfxbookEvents.forEach((e, i) => {
      console.log(`${i + 1}. ${e.title}`);
      console.log(`   Time: "${e.time}"`);
      console.log(`   TimeISO: ${e.timeISO || 'undefined'}`);
      console.log(`   Forecast: ${e.forecast}`);
      console.log('');
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await calendarService.close();
    await myfxbookService.close();
  }
}

debugAggregation().catch(console.error);
