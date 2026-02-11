import { chromium, Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';

async function debugForexFactoryHTML() {
  console.log('=== ForexFactory HTML Debug ===\n');
  
  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  
  const page: Page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
    timezoneId: 'America/New_York',
    locale: 'en-US',
  });

  try {
    console.log('Fetching https://www.forexfactory.com/calendar?day=today ...\n');
    await page.goto('https://www.forexfactory.com/calendar?day=today', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await page.waitForSelector('table.calendar__table', { timeout: 10000 });
    const html = await page.content();
    
    const $ = cheerio.load(html);
    const allRows = $('table.calendar__table tr');
    
    console.log(`Total rows found: ${allRows.length}\n`);
    console.log('=== ALL Events (checking for time) ===\n');
    
    let eventCount = 0;
    let eventsWithTime = 0;
    allRows.each((_, rowEl) => {
      const $row = $(rowEl);
      const currency = $row.find('.calendar__currency').text().trim();
      
      const title = $row.find('.calendar__event-title').text().trim();
      if (!title || title === 'Currency') return;
      
      eventCount++;
      
      // Get time
      const $timeCell = $row.find('.calendar__time');
      const timeRaw = $timeCell.text().trim();
      const timeHtml = $timeCell.html()?.trim() || '';
      
      if (timeRaw && timeRaw !== '' && timeRaw !== '—') {
        eventsWithTime++;
        console.log(`${eventCount}. [${currency}] ${title}`);
        console.log(`   ✅ Time: "${timeRaw}"`);
        console.log('');
      }
    });
    
    console.log(`\n=== Summary ===`);
    console.log(`Total events: ${eventCount}`);
    console.log(`Events with time: ${eventsWithTime}`);
    console.log(`Events without time: ${eventCount - eventsWithTime}`);
    
  } finally {
    await browser.close();
  }
}

debugForexFactoryHTML().catch(console.error);
