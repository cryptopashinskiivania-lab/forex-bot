/**
 * Quick test: MyfxbookService (Playwright) — fetch today's events.
 * Run: npx ts-node scripts/test-myfxbook-playwright.ts
 */
import { MyfxbookService } from '../src/services/MyfxbookService';

async function main() {
  const service = new MyfxbookService();
  try {
    const events = await service.getEventsForTodayRaw();
    console.log(`[MyfxbookService] getEventsForTodayRaw: ${events.length} events`);
    if (events.length > 0) {
      console.log('Sample:', events[0].title, events[0].currency, events[0].impact);
    }
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
