/**
 * Debug Myfxbook parsing - save HTML and check selectors
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ]
  });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'GMT',
    });

    const page = await context.newPage();
    
    console.log('Loading Myfxbook calendar...\n');
    await page.goto('https://www.myfxbook.com/forex-economic-calendar', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for possible elements
    await Promise.race([
      page.waitForSelector('table', { timeout: 10000 }),
      page.waitForSelector('.calendar-row', { timeout: 10000 }),
      page.waitForSelector('[data-event]', { timeout: 10000 }),
      page.waitForTimeout(5000),
    ]).catch(() => console.log('No standard selectors found, continuing...'));

    await page.waitForTimeout(3000);

    const html = await page.content();
    
    // Save HTML for inspection
    fs.writeFileSync('myfxbook-debug.html', html, 'utf-8');
    console.log('✅ HTML saved to myfxbook-debug.html\n');

    await page.close();
    await context.close();

    // Parse with Cheerio
    const $ = cheerio.load(html);
    
    console.log('=== DEBUG INFO ===\n');
    
    // Check for tables
    const tables = $('table');
    console.log(`Found ${tables.length} <table> elements`);
    
    // Check for calendar-specific classes
    const calendarRows = $('.calendar-row');
    console.log(`Found ${calendarRows.length} .calendar-row elements`);
    
    const dataEvents = $('[data-event]');
    console.log(`Found ${dataEvents.length} [data-event] elements`);
    
    // Check for common calendar structures
    const trElements = $('tr');
    console.log(`Found ${trElements.length} <tr> elements\n`);
    
    // Try to find any event-like structures
    console.log('=== SEARCHING FOR EVENT PATTERNS ===\n');
    
    // Look for time patterns
    const timeLikeElements = $('*').filter((i, el) => {
      const text = $(el).text().trim();
      return /\d{1,2}:\d{2}/.test(text) || /AM|PM/i.test(text);
    });
    console.log(`Found ${timeLikeElements.length} elements with time-like patterns`);
    
    // Look for currency codes
    const currencyElements = $('*').filter((i, el) => {
      const text = $(el).text().trim();
      return /^(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF)$/i.test(text);
    });
    console.log(`Found ${currencyElements.length} elements with currency codes`);
    
    // Look for impact indicators
    const impactElements = $('*').filter((i, el) => {
      const text = $(el).text().trim();
      return /high|medium|low/i.test(text);
    });
    console.log(`Found ${impactElements.length} elements with impact indicators\n`);
    
    // Sample first table structure
    if (tables.length > 0) {
      console.log('=== FIRST TABLE STRUCTURE ===\n');
      const firstTable = $(tables[0]);
      const firstRows = firstTable.find('tr').slice(0, 5);
      
      firstRows.each((i, row) => {
        const $row = $(row);
        const cells = $row.find('td, th');
        const cellTexts = cells.map((j, cell) => $(cell).text().trim().substring(0, 30)).get();
        console.log(`Row ${i + 1}: [${cellTexts.length} cells] ${cellTexts.join(' | ')}`);
      });
    }
    
    // Check page title
    const title = $('title').text();
    console.log(`\n=== PAGE TITLE ===\n${title}`);
    
    // Check for error messages or blocks
    const bodyText = $('body').text().substring(0, 500);
    console.log(`\n=== BODY START (first 500 chars) ===\n${bodyText}`);
    
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
