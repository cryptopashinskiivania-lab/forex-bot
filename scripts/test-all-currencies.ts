/**
 * Test: Show tomorrow events for ALL major currencies (including CAD, AUD, CHF)
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { fromZonedTime } from 'date-fns-tz';

dayjs.extend(utc);
dayjs.extend(timezone);

const FF_TZ = 'America/New_York';

function isEmpty(s: string): boolean {
  const t = (s || '').trim();
  return !t || t === '—' || t === '-';
}

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
    const baseDate = dayjs().tz(FF_TZ).add(1, 'day');
    
    // ALL major currencies (not just default 5)
    const ALL_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'NZD', 'CAD', 'AUD', 'CHF']);
    
    console.log('=== HIGH/MEDIUM IMPACT EVENTS (ALL MAJOR CURRENCIES) ===\n');
    
    const events: any[] = [];
    $('table.calendar__table tr').each((_, rowEl) => {
      const $row = $(rowEl);
      const $cells = $row.find('td');

      if ($cells.length < 5) return;
      
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

      if (!title || currency === 'Currency' || currency === 'All') return;
      
      // Filter by currency and impact
      const allowed = ALL_CURRENCIES.has(currency) && (impact === 'High' || impact === 'Medium');
      if (!allowed) return;

      // Filter empty events (unless it's special)
      const noActual = isEmpty(actual);
      const noForecast = isEmpty(forecast);
      const noPrevious = isEmpty(previous);
      const allEmpty = noActual && noForecast && noPrevious;
      const isSpeechMinutesStatement = /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(title);
      if (allEmpty && !isSpeechMinutesStatement) return;

      events.push({ currency, impact, title, time, forecast, previous, actual });
    });
    
    // Group by currency
    const byCurrency: Record<string, any[]> = {};
    events.forEach(e => {
      if (!byCurrency[e.currency]) byCurrency[e.currency] = [];
      byCurrency[e.currency].push(e);
    });
    
    // Sort currencies
    const sortedCurrencies = Object.keys(byCurrency).sort();
    
    sortedCurrencies.forEach(currency => {
      console.log(`\n📌 ${currency} (${byCurrency[currency].length} events):`);
      byCurrency[currency].forEach((e, i) => {
        const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
        console.log(`  ${i + 1}. ${impactEmoji} ${e.title}`);
        console.log(`     Time: ${e.time} | Forecast: ${e.forecast} | Previous: ${e.previous}`);
      });
    });
    
    console.log(`\n\n=== Summary ===`);
    console.log(`Total events: ${events.length}`);
    sortedCurrencies.forEach(currency => {
      console.log(`  ${currency}: ${byCurrency[currency].length}`);
    });
    
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
