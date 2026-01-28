/**
 * Check what assets are in the database (Multi-User version)
 */
import { database } from '../src/db/database';

console.log('=== Database Assets Check (Multi-User) ===\n');

// Get all users
const users = database.getUsers();

if (users.length === 0) {
  console.log('❌ No users found in database');
  console.log('Users are automatically registered when they interact with the bot');
  process.exit(0);
}

console.log(`Found ${users.length} user(s):\n`);

users.forEach(user => {
  const name = user.first_name || user.username || 'Unknown';
  console.log(`\n👤 User: ${user.user_id} (${name})`);
  console.log(`   Registered: ${new Date(user.registered_at).toLocaleString()}`);
  
  const assets = database.getMonitoredAssets(user.user_id);
  console.log(`   Monitored assets: ${assets.join(', ') || 'None'} (${assets.length} total)`);
  
  const rssEnabled = database.isRssEnabled(user.user_id);
  console.log(`   RSS enabled: ${rssEnabled ? '✅' : '❌'}`);
  
  const quietHoursEnabled = database.isQuietHoursEnabled(user.user_id);
  console.log(`   Quiet hours: ${quietHoursEnabled ? '✅ (23:00-08:00)' : '❌'}`);
});

console.log('\n✅ Done!');
