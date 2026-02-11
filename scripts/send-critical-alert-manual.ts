/**
 * Manual Critical Alert Sender
 * 
 * This script allows you to manually send critical data quality alerts to admin chat.
 * Use this when you want to notify admin about specific critical issues.
 * 
 * Usage: npx ts-node scripts/send-critical-alert-manual.ts
 */

import { database } from '../src/db/database';
import { env } from '../src/config/env';
import { Bot } from 'grammy';
import { initializeAdminAlerts, sendCriticalDataAlert } from '../src/utils/adminAlerts';
import { DataIssue } from '../src/types/DataQuality';

async function main() {
  console.log('🔍 Checking for critical data quality issues...\n');
  
  // Get recent issues from database
  const allIssues = database.getRecentDataIssues(1000);
  
  // Filter for critical issues from last hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentCriticalIssues = allIssues.filter(issue => 
    issue.created_at >= oneHourAgo &&
    (issue.type === 'MISSING_REQUIRED_FIELD' ||
     issue.type === 'TIME_INCONSISTENCY' ||
     issue.type === 'INVALID_RANGE')
  );
  
  console.log(`Found ${recentCriticalIssues.length} critical issues in the last hour`);
  
  if (recentCriticalIssues.length === 0) {
    console.log('✅ No critical issues to report. System is healthy!');
    return;
  }
  
  // Display issue summary
  console.log('\nIssue breakdown:');
  const byType: Record<string, number> = {};
  for (const issue of recentCriticalIssues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  - ${type}: ${count}`);
  }
  
  // Check if admin chat is configured
  if (!env.ADMIN_CHAT_ID) {
    console.log('\n⚠️  ADMIN_CHAT_ID not configured. Alert will NOT be sent.');
    console.log('Configure ADMIN_CHAT_ID in .env to enable alerts.');
    return;
  }
  
  // Initialize bot and send alert
  console.log('\n📤 Sending critical alert to admin chat...');
  
  const bot = new Bot(env.BOT_TOKEN);
  initializeAdminAlerts(bot);
  
  try {
    // Convert database issues to DataIssue format
    const dataIssues: DataIssue[] = recentCriticalIssues.map(issue => ({
      eventId: issue.event_id || 'unknown',
      source: issue.source as 'ForexFactory' | 'Myfxbook' | 'Merge',
      type: issue.type as any,
      message: issue.message,
      details: issue.details ? JSON.parse(issue.details) : {},
    }));
    
    await sendCriticalDataAlert(dataIssues, 'Manual Check - Last Hour');
    console.log('✅ Critical alert sent successfully!');
  } catch (error) {
    console.error('❌ Failed to send alert:', error);
  } finally {
    await bot.stop();
  }
}

main().catch(error => {
  console.error('Error in manual alert script:', error);
  process.exit(1);
});
