/**
 * Debug: fetch FF calendar, log table structure and first rows.
 * Run: npx ts-node scripts/debug-calendar-html.ts
 */
import cloudscraper from 'cloudscraper';
import * as cheerio from 'cheerio';

const CALENDAR_URL = 'https://www.forexfactory.com/calendar?day=today';

async function main() {
  const html = (await cloudscraper({
    uri: CALENDAR_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  })) as string;

  const $ = cheerio.load(html);
  const $rows = $('table.calendar__table tr');
  console.log('Total tr in table.calendar__table:', $rows.length);

  $rows.slice(0, 12).each((i, el) => {
    const $row = $(el);
    const $cells = $row.find('td');
    const hasCurrency = $row.find('.calendar__currency').length;
    const currency = $row.find('.calendar__currency').text().trim();
    const title = $row.find('.calendar__event-title').text().trim().replace(/\s+/g, ' ');
    const time = $row.find('.calendar__time').text().trim();
    const impactClass = $row.find('.calendar__impact span, .calendar__impact').attr('class') ?? '';
    const forecast = $row.find('.calendar__forecast').text().trim();
    const previous = $row.find('.calendar__previous').text().trim();

    console.log(`\n--- Row ${i} (td count: ${$cells.length}) ---`);
    console.log('  .calendar__currency:', JSON.stringify(currency), '(found:', hasCurrency, ')');
    console.log('  .calendar__event-title:', JSON.stringify(title?.slice(0, 60)));
    console.log('  .calendar__time:', JSON.stringify(time));
    console.log('  .calendar__impact class:', JSON.stringify(impactClass));
    console.log('  .calendar__forecast:', JSON.stringify(forecast));
    console.log('  .calendar__previous:', JSON.stringify(previous));

    if (i <= 2 && $row.html()) {
      const snippet = $row.html()!.replace(/\s+/g, ' ').slice(0, 400);
      console.log('  HTML snippet:', snippet + '...');
    }
    if (i === 4 || i === 5) {
      const $impact = $row.find('.calendar__impact');
      console.log('  .calendar__impact HTML:', $impact.html()?.replace(/\s+/g, ' ').slice(0, 300));
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
