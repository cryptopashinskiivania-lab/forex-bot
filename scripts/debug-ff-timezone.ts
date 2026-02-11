import { chromium } from 'playwright';

async function debugForexFactoryTimezone() {
  console.log('=== ForexFactory Timezone Debug ===\n');
  
  // Test with America/New_York (current setting)
  console.log('Test 1: With America/New_York timezone');
  const browser1 = await chromium.launch({ headless: true });
  const page1 = await browser1.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    timezoneId: 'America/New_York',
  });
  
  await page1.goto('https://www.forexfactory.com/calendar?day=today', { 
    waitUntil: 'domcontentloaded',
    timeout: 30000 
  });
  
  await page1.waitForSelector('table.calendar__table', { timeout: 10000 });
  
  // Get first USD event time
  const time1 = await page1.evaluate(() => {
    // @ts-ignore
    const rows = document.querySelectorAll('table.calendar__table tr');
    for (const row of rows) {
      // @ts-ignore
      const currency = row.querySelector('.calendar__currency')?.textContent?.trim();
      if (currency === 'USD') {
        // @ts-ignore
        const timeCell = row.querySelector('.calendar__time')?.textContent?.trim();
        // @ts-ignore
        const title = row.querySelector('.calendar__event-title')?.textContent?.trim();
        if (timeCell && timeCell !== '') {
          return { time: timeCell, title };
        }
      }
    }
    return null;
  });
  
  console.log('Result:', time1);
  await browser1.close();
  
  console.log('\n---\n');
  
  // Test with Europe/Kyiv (user's timezone)
  console.log('Test 2: With Europe/Kiev timezone');
  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    timezoneId: 'Europe/Kiev',
  });
  
  await page2.goto('https://www.forexfactory.com/calendar?day=today', { 
    waitUntil: 'domcontentloaded',
    timeout: 30000 
  });
  
  await page2.waitForSelector('table.calendar__table', { timeout: 10000 });
  
  const time2 = await page2.evaluate(() => {
    // @ts-ignore
    const rows = document.querySelectorAll('table.calendar__table tr');
    for (const row of rows) {
      // @ts-ignore
      const currency = row.querySelector('.calendar__currency')?.textContent?.trim();
      if (currency === 'USD') {
        // @ts-ignore
        const timeCell = row.querySelector('.calendar__time')?.textContent?.trim();
        // @ts-ignore
        const title = row.querySelector('.calendar__event-title')?.textContent?.trim();
        if (timeCell && timeCell !== '') {
          return { time: timeCell, title };
        }
      }
    }
    return null;
  });
  
  console.log('Result:', time2);
  await browser2.close();
  
  console.log('\n=== Analysis ===');
  if (time1 && time2) {
    console.log(`America/New_York: ${time1.time}`);
    console.log(`Europe/Kiev: ${time2.time}`);
    
    if (time1.time === time2.time) {
      console.log('\n❌ PROBLEM: ForexFactory does NOT respect browser timezone!');
      console.log('ForexFactory shows the same time regardless of timezone setting.');
      console.log('Need to check user settings on ForexFactory website.');
    } else {
      console.log('\n✅ ForexFactory respects browser timezone.');
      console.log('User should see different times based on their timezone.');
    }
  }
}

debugForexFactoryTimezone().catch(console.error);
