import { MyfxbookService } from '../src/services/MyfxbookService';

async function debugMyfxbook() {
  console.log('=== Myfxbook Debug ===\n');
  
  const service = new MyfxbookService();
  
  try {
    console.log('Fetching Myfxbook events for today...\n');
    const events = await service.getEventsForToday();
    
    console.log(`Total events: ${events.length}\n`);
    
    // Filter USD High/Medium
    const usdEvents = events.filter(e => 
      e.currency === 'USD' && (e.impact === 'High' || e.impact === 'Medium')
    );
    
    console.log(`USD High/Medium events: ${usdEvents.length}\n`);
    
    usdEvents.forEach((e, i) => {
      console.log(`${i + 1}. ${e.title}`);
      console.log(`   Currency: ${e.currency}`);
      console.log(`   Impact: ${e.impact}`);
      console.log(`   Time: "${e.time}"`);
      console.log(`   TimeISO: ${e.timeISO || 'undefined'}`);
      console.log(`   Forecast: ${e.forecast}`);
      console.log(`   Previous: ${e.previous}`);
      console.log(`   Actual: ${e.actual}`);
      console.log('');
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await service.close();
  }
}

debugMyfxbook().catch(console.error);
