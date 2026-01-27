import { CalendarService } from '../src/services/CalendarService';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

async function debugForexFactoryParsing() {
  console.log('=== ForexFactory Debug Script ===\n');
  
  // 1. Fetch HTML using Playwright
  console.log('[1] Fetching HTML via Playwright...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  
  const url = 'https://www.forexfactory.com/calendar?day=today';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('table.calendar__table', { timeout: 10000 });
  
  const html = await page.content();
  await browser.close();
  
  console.log(`✓ HTML fetched (${html.length} bytes)\n`);
  
  // 2. Save HTML to file
  const htmlPath = path.join(__dirname, 'debug-ff-html.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`[2] HTML saved to: ${htmlPath}\n`);
  
  // 3. Parse HTML
  console.log('[3] Parsing HTML...');
  const $ = cheerio.load(html);
  
  const allRows = $('table.calendar__table tr.calendar__row');
  console.log(`Total rows found: ${allRows.length}`);
  
  if (allRows.length === 0) {
    console.log('❌ No rows found! Table might be empty or selectors are wrong.\n');
    console.log('Checking for table existence:');
    console.log(`  - table.calendar__table: ${$('table.calendar__table').length}`);
    console.log(`  - Any table: ${$('table').length}`);
    return;
  }
  
  let eventsParsed = 0;
  let eventsFiltered = 0;
  const filterReasons: Record<string, number> = {};
  
  let currentDate = '';
  
  allRows.each((_, row) => {
    const $row = $(row);
    
    // Check for date row
    const dateText = $row.find('td.calendar__date').text().trim();
    if (dateText) {
      currentDate = dateText;
      console.log(`\nDate row: ${dateText}`);
      return;
    }
    
    // Parse event
    const title = $row.find('.calendar__event-title').text().trim();
    if (!title) return;
    
    const currency = $row.find('.calendar__currency').text().trim();
    const timeText = $row.find('.calendar__time').text().trim();
    
    const $impactSpan = $row.find('.calendar__impact span');
    const impactClass = $impactSpan.attr('class')?.toLowerCase() ?? '';
    
    let impact: 'High' | 'Medium' | 'Low' = 'Low';
    if (impactClass.includes('icon--ff-impact-red')) {
      impact = 'High';
    } else if (impactClass.includes('icon--ff-impact-orange') || impactClass.includes('icon--ff-impact-ora')) {
      impact = 'Medium';
    }
    
    eventsParsed++;
    
    console.log(`\nEvent ${eventsParsed}:`);
    console.log(`  Title: ${title}`);
    console.log(`  Currency: ${currency}`);
    console.log(`  Time: ${timeText}`);
    console.log(`  Impact: ${impact} (class: ${impactClass})`);
    
    // Check filters
    const reasons: string[] = [];
    
    if (!title || currency === 'Currency' || currency === 'All') {
      reasons.push('invalid_title_or_currency');
    }
    
    if (impact === 'Low') {
      reasons.push('low_impact');
    }
    
    // Check monitored currencies (hardcoded for now)
    const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY'];
    if (!ALLOWED_CURRENCIES.includes(currency)) {
      reasons.push(`currency_not_monitored (${currency})`);
    }
    
    if (reasons.length > 0) {
      eventsFiltered++;
      console.log(`  ❌ FILTERED: ${reasons.join(', ')}`);
      reasons.forEach(r => {
        filterReasons[r] = (filterReasons[r] || 0) + 1;
      });
    } else {
      console.log(`  ✓ PASSED all filters`);
    }
  });
  
  // 4. Summary
  console.log('\n=== Summary ===');
  console.log(`Total rows: ${allRows.length}`);
  console.log(`Events parsed: ${eventsParsed}`);
  console.log(`Events filtered out: ${eventsFiltered}`);
  console.log(`Events that passed: ${eventsParsed - eventsFiltered}`);
  
  if (Object.keys(filterReasons).length > 0) {
    console.log('\nFilter reasons:');
    Object.entries(filterReasons).forEach(([reason, count]) => {
      console.log(`  - ${reason}: ${count}`);
    });
  }
  
  // 5. Test with CalendarService
  console.log('\n=== Testing with CalendarService ===');
  const service = new CalendarService();
  const events = await service.getEventsForToday();
  console.log(`CalendarService returned: ${events.length} events`);
  
  if (events.length > 0) {
    console.log('\nEvents:');
    events.forEach((e, i) => {
      console.log(`${i + 1}. [${e.currency}] ${e.title} - ${e.time} (${e.impact})`);
    });
  }
  
  await service.close();
}

debugForexFactoryParsing().catch(console.error);
