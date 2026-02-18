/**
 * One-off: dump raw RSS item fields (pubDate, first table cell = Time left) to see actual format.
 */
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';

const RSS_FEED_URL = 'https://www.myfxbook.com/rss/forex-economic-calendar-events';

async function main() {
  const parser = new Parser({ customFields: { item: ['description', 'content:encoded'] } });
  const feed = await parser.parseURL(RSS_FEED_URL);
  if (!feed.items?.length) {
    console.log('No items');
    return;
  }
  console.log('=== Raw RSS dump: High/Medium items (first 12) ===\n');
  let shown = 0;
  for (let i = 0; i < feed.items.length && shown < 12; i++) {
    const item = feed.items[i];
    const desc = item.content || item.description || '';
    if (!desc.toLowerCase().includes('sprite-high-impact') && !desc.toLowerCase().includes('sprite-medium-impact')) continue;
    shown++;
    const pubDate = item.pubDate ?? '(none)';
    let firstCell = '(no table)';
    const $ = cheerio.load(desc);
    const rows = $('table tr');
    if (rows.length >= 2) {
      const cells = rows.eq(1).find('td');
      if (cells.length >= 1) firstCell = cells.eq(0).text().trim();
    }
    console.log(`[${shown}] title: ${(item.title || '').slice(0, 55)}`);
    console.log(`    pubDate: ${pubDate}`);
    console.log(`    first cell (Time left): "${firstCell}"`);
    console.log('');
  }
  console.log(`Total High/Medium shown: ${shown}`);

  const dates = new Set<string>();
  for (const item of feed.items) {
    const d = item.content || item.description || '';
    if (!d.toLowerCase().includes('sprite-high-impact') && !d.toLowerCase().includes('sprite-medium-impact')) continue;
    const pd = item.pubDate ? new Date(item.pubDate) : null;
    if (pd) dates.add(pd.toISOString().slice(0, 10));
  }
  console.log('\n=== Unique dates (YYYY-MM-DD) in RSS for High/Medium events ===');
  console.log(Array.from(dates).sort().join(', ') || '(none)');
  console.log('=== Done ===');
}

main().catch(console.error);
