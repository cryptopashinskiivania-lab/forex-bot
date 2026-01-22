/**
 * Quick test: fetch ForexFactory calendar and log scraped events.
 * Run: npx ts-node scripts/test-calendar-scrape.ts
 */
import { CalendarService } from '../src/services/CalendarService';

async function main() {
  const service = new CalendarService();
  console.log('Fetching https://www.forexfactory.com/calendar?day=today ...\n');
  const events = await service.getEventsForToday();
  console.log(`Found ${events.length} events (USD/GBP/EUR/JPY/NZD, High/Medium impact):\n`);
  events.forEach((e, i) => {
    console.log(`${i + 1}. [${e.currency}] ${e.impact} | ${e.time}`);
    console.log(`   ${e.title}`);
    console.log(`   Forecast: ${e.forecast} | Previous: ${e.previous}\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
