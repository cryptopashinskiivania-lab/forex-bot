/**
 * Debug script: run notification pipeline (users → events → filter).
 * Notifications: events without time, RSS (no digest/reminders/results).
 * Run: npx ts-node scripts/debug-notifications.ts
 */
import 'dotenv/config';
import { toZonedTime } from 'date-fns-tz';
import { database } from '../src/db/database';
import { CalendarService } from '../src/services/CalendarService';
import { MyfxbookService } from '../src/services/MyfxbookService';
import { DataQualityService } from '../src/services/DataQualityService';
import { aggregateCoreEvents } from '../src/utils/eventAggregation';

function isQuietHours(userId: number): boolean {
  if (!database.isQuietHoursEnabled(userId)) return false;
  const userTz = database.getTimezone(userId);
  const now = new Date();
  const localTime = toZonedTime(now, userTz);
  const hour = localTime.getHours();
  return hour >= 23 || hour < 8;
}

async function main() {
  console.log('=== Notification pipeline debug ===\n');

  const users = database.getUsers();
  console.log(`Users in DB: ${users.length}`);
  if (users.length === 0) {
    console.log('No users — register with /start in the bot first.');
    return;
  }

  const calendarService = new CalendarService();
  const myfxbookService = new MyfxbookService();
  const dataQualityService = new DataQualityService();

  try {
    for (const user of users.slice(0, 3)) {
      const userId = user.user_id;
      const userTz = database.getTimezone(userId);
      const monitoredAssets = database.getMonitoredAssets(userId);
      const now = new Date();
      const localTime = toZonedTime(now, userTz);
      const hour = localTime.getHours();
      const minute = localTime.getMinutes();

      console.log(`\n--- User ${userId} (tz: ${userTz}) ---`);
      console.log(`  Monitored assets: ${monitoredAssets.join(', ')}`);
      console.log(`  Local time: ${hour}:${String(minute).padStart(2, '0')}`);
      console.log(`  Quiet hours (23-08): ${isQuietHours(userId)}`);

      const events = await aggregateCoreEvents(calendarService, myfxbookService, userId, false);
      const userEventsRaw = events.filter((e) => monitoredAssets.includes(e.currency));
      const { deliver: userEvents, skipped } = dataQualityService.filterForDelivery(userEventsRaw, {
        mode: 'general',
        nowUtc: now,
      });

      console.log(`  Events: total=${events.length}, for assets=${userEventsRaw.length}, after filter=${userEvents.length}, skipped=${skipped.length}`);

      if (skipped.length > 0) {
        const byType = skipped.reduce((acc: Record<string, number>, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1;
          return acc;
        }, {});
        console.log(`  Skipped reasons: ${JSON.stringify(byType)}`);
      }

      const eventsWithoutTime = userEvents.filter((e) => !e.timeISO);
      console.log(`  Events without time (would be sent if not quiet): ${eventsWithoutTime.length}`);
      for (const e of userEvents.slice(0, 5)) {
        console.log(`  [${e.currency}] ${e.title}: timeISO=${e.timeISO ? 'yes' : 'no'}`);
      }
      if (userEvents.length > 5) console.log(`  ... and ${userEvents.length - 5} more events`);
    }
  } finally {
    await calendarService.close();
    await myfxbookService.close();
  }
  console.log('\n=== Done ===');
}

main().catch(console.error);
