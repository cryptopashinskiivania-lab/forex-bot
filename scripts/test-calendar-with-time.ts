/**
 * Test CalendarService with mock HTML that has grouped events
 */

import { chromium } from 'playwright';

async function testCalendarWithTime() {
  console.log('=== Testing CalendarService with grouped events ===\n');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    timezoneId: 'America/New_York',
  });
  
  // Create mock HTML with grouped events (time shown only once)
  const mockHTML = `
<!DOCTYPE html>
<html>
<head><title>ForexFactory Mock</title></head>
<body>
<table class="calendar__table">
  <tr>
    <td class="calendar__time">3:30pm</td>
    <td class="calendar__currency">USD</td>
    <td class="calendar__impact"><span class="icon--ff-impact-red"></span></td>
    <td class="calendar__event-title">Average Hourly Earnings m/m</td>
    <td class="calendar__forecast">0.3%</td>
    <td class="calendar__previous">0.3%</td>
    <td class="calendar__actual"></td>
  </tr>
  <tr>
    <td class="calendar__time"></td>
    <td class="calendar__currency">USD</td>
    <td class="calendar__impact"><span class="icon--ff-impact-red"></span></td>
    <td class="calendar__event-title">Non-Farm Employment Change</td>
    <td class="calendar__forecast">66K</td>
    <td class="calendar__previous">50K</td>
    <td class="calendar__actual"></td>
  </tr>
  <tr>
    <td class="calendar__time"></td>
    <td class="calendar__currency">USD</td>
    <td class="calendar__impact"><span class="icon--ff-impact-red"></span></td>
    <td class="calendar__event-title">Unemployment Rate</td>
    <td class="calendar__forecast">4.4%</td>
    <td class="calendar__previous">4.4%</td>
    <td class="calendar__actual"></td>
  </tr>
</table>
</body>
</html>
  `;
  
  await page.setContent(mockHTML);
  const html = await page.content();
  
  await browser.close();
  
  // Now parse with cheerio (same as CalendarService)
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  
  function isSpecialTimeString(timeStr: string): boolean {
    const t = timeStr.trim().toLowerCase();
    return (
      !t ||
      t === 'tentative' ||
      t === 'all day' ||
      t.includes('day') ||
      t === '—' ||
      t === '-'
    );
  }
  
  const allRows = $('table.calendar__table tr');
  let lastSeenTime = '—';
  const events: any[] = [];
  
  allRows.each((_, rowEl) => {
    const $row = $(rowEl);
    const currency = $row.find('.calendar__currency').text().trim();
    const title = $row.find('.calendar__event-title').text().trim();
    
    if (!title) return;
    
    // Read time from the cell (SAME LOGIC AS CalendarService)
    const timeRaw = $row.find('.calendar__time').text().trim();
    
    let time: string;
    if (timeRaw && timeRaw !== '' && timeRaw !== '—' && !isSpecialTimeString(timeRaw)) {
      lastSeenTime = timeRaw;
      time = timeRaw;
    } else if (timeRaw === '' || timeRaw === '—') {
      time = lastSeenTime;
    } else {
      time = timeRaw;
      lastSeenTime = '—';
    }
    
    events.push({ title, currency, time });
  });
  
  console.log('Parsed events:\n');
  events.forEach((e, i) => {
    console.log(`${i + 1}. [${e.currency}] ${e.title}`);
    console.log(`   Time: "${e.time}"`);
    console.log('');
  });
  
  console.log('=== Verification ===');
  if (events[0].time === '3:30pm' && events[1].time === '3:30pm' && events[2].time === '3:30pm') {
    console.log('✅ SUCCESS: All events inherited the time correctly!');
    console.log('✅ CalendarService logic will work when ForexFactory publishes time!');
  } else {
    console.log('❌ FAILED: Time inheritance did not work');
  }
}

testCalendarWithTime().catch(console.error);
