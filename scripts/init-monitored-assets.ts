import { database } from '../src/db/database';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Initialize monitored assets with default currencies for a specific user
 * Note: This script is for testing/setup purposes only
 * In production, each user manages their own settings via /settings command
 */
function initMonitoredAssets() {
  console.log('=== Initializing Monitored Assets (Multi-User) ===\n');
  
  const adminChatId = process.env.ADMIN_CHAT_ID;
  
  if (!adminChatId) {
    console.log('❌ ADMIN_CHAT_ID not set in .env file');
    console.log('Set ADMIN_CHAT_ID to initialize settings for a specific user');
    process.exit(1);
  }
  
  const userId = parseInt(adminChatId, 10);
  
  if (isNaN(userId)) {
    console.log('❌ Invalid ADMIN_CHAT_ID (must be a number)');
    process.exit(1);
  }
  
  console.log(`Setting up monitored assets for user: ${userId}\n`);
  
  // Register user if not exists
  database.registerUser(userId, 'admin', 'Admin', 'User');
  
  // Default currencies - only major pairs enabled by default
  const enabledCurrencies = ['USD', 'EUR', 'GBP', 'JPY'];
  
  console.log('Current monitored assets:');
  const current = database.getMonitoredAssets(userId);
  console.log(current.length > 0 ? current.join(', ') : 'EMPTY!\n');
  
  console.log('\nSetting currencies for user:');
  database.setAssets(userId, enabledCurrencies);
  enabledCurrencies.forEach(currency => {
    console.log(`✓ Added: ${currency}`);
  });
  
  console.log('\nFinal monitored assets:');
  const final = database.getMonitoredAssets(userId);
  console.log(final.join(', '));
  
  console.log(`\n✅ Done! User ${userId} is now monitoring ${final.length} currencies.`);
  console.log('\n💡 Note: Each user can customize their settings via /settings command in the bot');
}

initMonitoredAssets();
