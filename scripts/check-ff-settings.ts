import { chromium } from 'playwright';

async function checkForexFactorySettings() {
  console.log('=== ForexFactory Settings Check ===\n');
  
  const browser = await chromium.launch({ headless: false }); // Non-headless to see what happens
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    timezoneId: 'Europe/Kiev',
  });
  
  await page.goto('https://www.forexfactory.com/calendar?day=today', { 
    waitUntil: 'domcontentloaded',
    timeout: 30000 
  });
  
  await page.waitForSelector('table.calendar__table', { timeout: 10000 });
  
  // Check for timezone settings in localStorage
  const localStorage = await page.evaluate(() => {
    // @ts-ignore
    return JSON.stringify(window.localStorage);
  });
  
  console.log('LocalStorage:', localStorage);
  
  // Check cookies
  const cookies = await page.context().cookies();
  console.log('\nCookies:');
  cookies.forEach(cookie => {
    if (cookie.name.toLowerCase().includes('time') || 
        cookie.name.toLowerCase().includes('zone') ||
        cookie.name.toLowerCase().includes('tz')) {
      console.log(`  ${cookie.name} = ${cookie.value}`);
    }
  });
  
  // Look for timezone selector on page
  const tzInfo = await page.evaluate(() => {
    // @ts-ignore
    const html = document.documentElement.innerHTML;
    // Look for timezone related text
    const matches = html.match(/timezone|time zone|GMT|UTC|EST|EDT|PST|PDT/gi);
    return matches ? matches.slice(0, 20) : [];
  });
  
  console.log('\nTimezone mentions on page:', tzInfo);
  
  // Wait a bit for user to see
  console.log('\n⏳ Waiting 5 seconds for you to inspect the page...');
  await page.waitForTimeout(5000);
  
  await browser.close();
  
  console.log('\n=== Recommendation ===');
  console.log('ForexFactory likely uses server-side timezone settings.');
  console.log('Check: https://www.forexfactory.com/calendar (look for timezone dropdown)');
}

checkForexFactorySettings().catch(console.error);
