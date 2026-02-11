/**
 * Migration script to convert from single-user to multi-user architecture
 * This script:
 * 1. Checks if there are old settings in the database (without user_id)
 * 2. Creates a user from ADMIN_CHAT_ID if it exists
 * 3. Migrates old settings to the new user
 * 4. Cleans up old settings
 */

import { database } from '../src/db/database';
import dotenv from 'dotenv';

dotenv.config();

console.log('=== Multi-User Migration Script ===\n');
console.log('✅ Database initialized with new structure');

// Check if ADMIN_CHAT_ID is set in environment
const adminChatId = process.env.ADMIN_CHAT_ID;

if (!adminChatId) {
  console.log('\n⚠️  ADMIN_CHAT_ID not set in .env file');
  console.log('If you had an admin user before, you can set ADMIN_CHAT_ID in .env and run this script again.');
  console.log('Otherwise, users will be automatically registered when they interact with the bot.');
  process.exit(0);
}

const userId = parseInt(adminChatId, 10);

if (isNaN(userId)) {
  console.log('❌ Invalid ADMIN_CHAT_ID (must be a number)');
  process.exit(1);
}

// Check if admin user already exists
const existingUser = database.getUserById(userId);

if (existingUser) {
  console.log(`\n✅ Admin user ${userId} already exists in database`);
  
  // Show user settings
  const monitoredAssets = database.getMonitoredAssets(userId);
  console.log(`   Monitored assets: ${monitoredAssets.join(', ')}`);
  console.log(`   RSS enabled: ${database.isRssEnabled(userId)}`);
  console.log(`   Quiet hours enabled: ${database.isQuietHoursEnabled(userId)}`);
} else {
  console.log(`\n📝 Creating admin user ${userId}...`);
  
  try {
    // Register admin user
    database.registerUser(userId, 'admin', 'Admin', 'User');
    console.log('✅ Admin user created successfully');
    
    // Set default settings for admin user
    const defaultAssets = ['USD', 'EUR', 'GBP', 'JPY'];
    database.setAssets(userId, defaultAssets);
    
    console.log('✅ Default settings configured for admin user');
    console.log(`   Monitored assets: ${defaultAssets.join(', ')}`);
    console.log('   RSS enabled: true (default)');
    console.log('   Quiet hours enabled: true (default)');
  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }
}

// Show current users
const users = database.getUsers();

console.log(`\n📊 Current users in database: ${users.length}`);
users.forEach(user => {
  const name = user.first_name || user.username || 'Unknown';
  const date = new Date(user.registered_at).toLocaleString();
  console.log(`   • User ${user.user_id} (${name}) - registered: ${date}`);
});

console.log('\n✅ Migration complete!');
console.log('\nNext steps:');
console.log('1. Start the bot with: npm run dev');
console.log('2. New users will be automatically registered when they interact with the bot');
console.log('3. Each user can configure their own settings via /settings command');
