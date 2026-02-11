/**
 * Daily Quality Report Script
 * 
 * Generates a summary report of data quality issues from the last 24 hours
 * and sends it to the admin Telegram chat.
 * 
 * Usage: npx ts-node scripts/daily-quality-report.ts
 */

import { database } from '../src/db/database';
import { env } from '../src/config/env';
import { Bot } from 'grammy';

interface IssueSummary {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  recentExamples: Array<{
    type: string;
    source: string;
    message: string;
    created_at: number;
  }>;
}

function generateQualityReport(): IssueSummary {
  const issues = database.getRecentDataIssues(1000);
  
  // Filter issues from last 24 hours
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentIssues = issues.filter(issue => issue.created_at >= oneDayAgo);
  
  const summary: IssueSummary = {
    total: recentIssues.length,
    byType: {},
    bySource: {},
    recentExamples: [],
  };
  
  // Count by type
  for (const issue of recentIssues) {
    summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
    summary.bySource[issue.source] = (summary.bySource[issue.source] || 0) + 1;
  }
  
  // Get top 5 most recent examples
  summary.recentExamples = recentIssues
    .slice(0, 5)
    .map(issue => ({
      type: issue.type,
      source: issue.source,
      message: issue.message,
      created_at: issue.created_at,
    }));
  
  return summary;
}

function formatReportMessage(summary: IssueSummary, previousDaySummary?: IssueSummary): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [];
  
  lines.push('📊 <b>Daily Data Quality Report</b>');
  lines.push('');
  lines.push(`<b>Period:</b> Last 24 hours`);
  lines.push(`<b>Total Issues:</b> ${summary.total}`);
  
  // Show trend if we have previous day data
  if (previousDaySummary) {
    const change = summary.total - previousDaySummary.total;
    const trend = change > 0 ? `📈 +${change}` : change < 0 ? `📉 ${change}` : '➡️ No change';
    lines.push(`<b>Trend:</b> ${trend}`);
  }
  
  lines.push('');
  
  // Issues by type
  lines.push('<b>Issues by Type:</b>');
  const sortedTypes = Object.entries(summary.byType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    const percentage = ((count / summary.total) * 100).toFixed(1);
    lines.push(`  • ${escape(type)}: ${count} (${percentage}%)`);
  }
  
  lines.push('');
  
  // Issues by source
  lines.push('<b>Issues by Source:</b>');
  const sortedSources = Object.entries(summary.bySource).sort((a, b) => b[1] - a[1]);
  for (const [source, count] of sortedSources) {
    const percentage = ((count / summary.total) * 100).toFixed(1);
    lines.push(`  • ${escape(source)}: ${count} (${percentage}%)`);
  }
  
  // Recent examples
  if (summary.recentExamples.length > 0) {
    lines.push('');
    lines.push('<b>Recent Examples:</b>');
    for (const example of summary.recentExamples) {
      const date = new Date(example.created_at);
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      lines.push(`  • [${timeStr}] ${escape(example.type)} (${escape(example.source)})`);
      lines.push(`    ${escape(example.message.substring(0, 80))}${example.message.length > 80 ? '...' : ''}`);
    }
  }
  
  lines.push('');
  lines.push('---');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US');
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  lines.push(`<i>Generated: ${dateStr} ${timeStr}</i>`);
  
  return lines.join('\n');
}

async function sendReportToAdmin(report: string): Promise<void> {
  if (!env.ADMIN_CHAT_ID) {
    console.log('⚠️  ADMIN_CHAT_ID not configured. Report not sent.');
    console.log('\n📄 Report Preview:\n');
    console.log(report);
    return;
  }
  
  const bot = new Bot(env.BOT_TOKEN);
  
  try {
    await bot.api.sendMessage(env.ADMIN_CHAT_ID, report, {
      parse_mode: 'HTML',
    });
    console.log('✅ Daily quality report sent to admin chat');
  } catch (error) {
    console.error('❌ Failed to send report to admin:', error);
    console.log('\n📄 Report Preview:\n');
    console.log(report);
  } finally {
    await bot.stop();
  }
}

async function main() {
  console.log('🔍 Generating daily data quality report...\n');
  
  const currentSummary = generateQualityReport();
  
  // Optionally, get previous day summary for trend analysis
  // For now, we'll just generate current summary
  const report = formatReportMessage(currentSummary);
  
  // Display in console
  console.log(report);
  console.log('');
  
  // Send to admin if configured
  await sendReportToAdmin(report);
}

main().catch(error => {
  console.error('Error generating daily quality report:', error);
  process.exit(1);
});
