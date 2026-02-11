/**
 * Debug: Show ALL events from ForexFactory (before filtering)
 * Run: npx ts-node scripts/debug-tomorrow.ts
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

async function main() {
  const browser = await chromium.launch({ headless: true });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    await context.addCookies([{
      name: 'fftimezone',
      value: 'America/New_York',
      domain: '.forexfactory.com',
      path: '/',
    }]);

    const page = await context.newPage();
    
    console.log('Loading ForexFactory calendar for tomorrow...\n');
    await page.goto('https://www.forexfactory.com/calendar?day=tomorrow', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('table.calendar__table', { timeout: 20000 });
    await page.waitForTimeout(2000);

    const html = await page.content();
    await page.close();
    await context.close();

    const $ = cheerio.load(html);
    
    console.log('=== ALL EVENTS (BEFORE FILTERING) ===\n');
    
    let rowNum = 0;
    $('table.calendar__table tr').each((_, rowEl) => {
      const $row = $(rowEl);
      const $cells = $row.find('td');

      if ($cells.length < 5) return;

      rowNum++;
      
      const currency = $row.find('.calendar__currency').text().trim();
      const title = $row.find('.calendar__event-title').text().trim().replace(/\s+/g, ' ');
      const time = $row.find('.calendar__time').text().trim() || '—';
      const forecast = $row.find('.calendar__forecast').text().trim() || '—';
      const previous = $row.find('.calendar__previous').text().trim() || '—';
      const actual = $row.find('.calendar__actual').text().trim() || '—';
      
      // Impact
      const $impactSpan = $row.find('.calendar__impact span');
      const impactClass = $impactSpan.attr('class')?.toLowerCase() ?? '';
      let impact = 'Low';
      if (impactClass.includes('icon--ff-impact-red')) {
        impact = 'High';
      } else if (impactClass.includes('icon--ff-impact-orange') || impactClass.includes('icon--ff-impact-ora')) {
        impact = 'Medium';
      }

      console.log(`${rowNum}. [${currency}] ${impact} | ${title}`);
      console.log(`   Time: ${time}`);
      console.log(`   Forecast: ${forecast} | Previous: ${previous} | Actual: ${actual}`);
      console.log(`   Impact class: ${impactClass}`);
      console.log('');
    });
    
    console.log(`\nTotal rows processed: ${rowNum}`);
    
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
