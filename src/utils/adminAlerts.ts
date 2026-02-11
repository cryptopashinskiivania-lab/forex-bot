/**
 * Admin Alert Utility
 * 
 * Sends critical alerts to admin Telegram chat when serious data quality issues are detected.
 */

import { Bot } from 'grammy';
import { env } from '../config/env';
import { DataIssue } from '../types/DataQuality';

let botInstance: Bot | null = null;
let lastAlertTime: Record<string, number> = {};

// Throttle alerts to prevent spam (don't send same type more than once per hour)
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Initialize the bot instance for sending alerts
 * Call this once when the bot starts
 */
export function initializeAdminAlerts(bot: Bot): void {
  botInstance = bot;
}

/**
 * Check if we should throttle this alert type
 */
function shouldThrottle(alertType: string): boolean {
  const now = Date.now();
  const lastTime = lastAlertTime[alertType] || 0;
  
  if (now - lastTime < ALERT_THROTTLE_MS) {
    return true;
  }
  
  lastAlertTime[alertType] = now;
  return false;
}

/**
 * Send critical data quality alert to admin
 */
export async function sendCriticalDataAlert(
  issues: DataIssue[],
  context: string
): Promise<void> {
  // Check if admin chat is configured
  if (!env.ADMIN_CHAT_ID) {
    console.log('[AdminAlerts] ADMIN_CHAT_ID not configured, skipping alert');
    return;
  }
  
  if (!botInstance) {
    console.warn('[AdminAlerts] Bot instance not initialized');
    return;
  }
  
  // Filter for critical issue types
  const criticalIssues = issues.filter(issue =>
    issue.type === 'MISSING_REQUIRED_FIELD' ||
    issue.type === 'TIME_INCONSISTENCY' ||
    issue.type === 'INVALID_RANGE'
  );
  
  if (criticalIssues.length === 0) {
    return;
  }
  
  // Check throttling for critical alerts
  if (shouldThrottle('CRITICAL_DATA_ISSUES')) {
    console.log('[AdminAlerts] Throttling critical data alert (sent recently)');
    return;
  }
  
  // Build alert message (using HTML format)
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  const lines: string[] = [];
  lines.push('⚠️ <b>Critical Data Quality Issues Detected!</b>');
  lines.push('');
  lines.push(`<b>Context:</b> ${escape(context)}`);
  lines.push(`<b>Total Critical Issues:</b> ${criticalIssues.length}`);
  lines.push('');
  
  // Group by type
  const byType: Record<string, number> = {};
  for (const issue of criticalIssues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  }
  
  lines.push('<b>Issue Breakdown:</b>');
  for (const [type, count] of Object.entries(byType)) {
    lines.push(`  • ${escape(type)}: ${count}`);
  }
  
  // Show first 3 examples
  lines.push('');
  lines.push('<b>Examples:</b>');
  for (const issue of criticalIssues.slice(0, 3)) {
    lines.push(`  • ${escape(issue.type)} (${escape(issue.source)})`);
    const msg = issue.message.substring(0, 100);
    lines.push(`    ${escape(msg)}${issue.message.length > 100 ? '...' : ''}`);
  }
  
  lines.push('');
  lines.push('<i>Check database for full details</i>');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US');
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  lines.push(`<i>Time: ${dateStr} ${timeStr}</i>`);
  
  const message = lines.join('\n');
  
  try {
    await botInstance.api.sendMessage(env.ADMIN_CHAT_ID, message, {
      parse_mode: 'HTML',
    });
    console.log('[AdminAlerts] Critical data alert sent to admin');
  } catch (error) {
    console.error('[AdminAlerts] Failed to send alert:', error);
  }
}

/**
 * Send high-volume issue alert to admin
 */
export async function sendHighVolumeIssueAlert(
  issueType: string,
  count: number,
  threshold: number,
  context: string
): Promise<void> {
  if (!env.ADMIN_CHAT_ID || !botInstance) {
    return;
  }
  
  // Check throttling
  if (shouldThrottle(`HIGH_VOLUME_${issueType}`)) {
    return;
  }
  
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US');
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  
  const message = `⚠️ <b>High Volume of ${escape(issueType)} Issues</b>\n\n` +
    `<b>Context:</b> ${escape(context)}\n` +
    `<b>Count:</b> ${count} (threshold: ${threshold})\n` +
    `<b>Action Required:</b> Investigate data source\n\n` +
    `<i>Time: ${dateStr} ${timeStr}</i>`;
  
  try {
    await botInstance.api.sendMessage(env.ADMIN_CHAT_ID, message, {
      parse_mode: 'HTML',
    });
    console.log(`[AdminAlerts] High volume alert sent for ${issueType}`);
  } catch (error) {
    console.error('[AdminAlerts] Failed to send alert:', error);
  }
}
