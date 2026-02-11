/**
 * Migrate all users to include new assets (CAD, AUD, CHF)
 * This is an example script - in production, users manage their own settings
 */
import { database } from '../src/db/database';

console.log('=== Migrate User Assets ===\n');

const users = database.getUsers();

if (users.length === 0) {
  console.log('❌ No users found in database');
  process.exit(0);
}

// Update to new default set
const NEW_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'];

console.log(`Found ${users.length} user(s). Updating their assets to: ${NEW_ASSETS.join(', ')}\n`);

users.forEach(user => {
  const name = user.first_name || user.username || 'Unknown';
  console.log(`\n👤 User: ${user.user_id} (${name})`);
  
  const currentAssets = database.getMonitoredAssets(user.user_id);
  console.log(`   Before: ${currentAssets.join(', ') || 'None'}`);
  
  database.setAssets(user.user_id, NEW_ASSETS);
  
  const updatedAssets = database.getMonitoredAssets(user.user_id);
  console.log(`   After:  ${updatedAssets.join(', ')}`);
});

console.log('\n✅ Migration complete!');
console.log('💡 Note: Users can customize their settings anytime via /settings command');
