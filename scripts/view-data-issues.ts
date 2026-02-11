/**
 * Script to view data quality issues from the database
 * 
 * Usage: npx ts-node scripts/view-data-issues.ts
 */

import { database } from '../src/db/database';

interface IssueStats {
  [key: string]: number;
}

function main() {
  console.log('='.repeat(80));
  console.log('DATA QUALITY ISSUES REPORT');
  console.log('='.repeat(80));
  console.log();

  // Get recent issues
  const issues = database.getRecentDataIssues(100);

  if (issues.length === 0) {
    console.log('✅ No data quality issues found in the last 7 days!');
    return;
  }

  console.log(`📊 Total issues found: ${issues.length}`);
  console.log();

  // Group by type
  const byType = issues.reduce((acc: IssueStats, issue) => {
    acc[issue.type] = (acc[issue.type] || 0) + 1;
    return acc;
  }, {});

  console.log('Issues by type:');
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      const percentage = ((count / issues.length) * 100).toFixed(1);
      console.log(`  ${type.padEnd(30)} ${count} (${percentage}%)`);
    });
  console.log();

  // Group by source
  const bySource = issues.reduce((acc: IssueStats, issue) => {
    acc[issue.source] = (acc[issue.source] || 0) + 1;
    return acc;
  }, {});

  console.log('Issues by source:');
  Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .forEach(([source, count]) => {
      const percentage = ((count / issues.length) * 100).toFixed(1);
      console.log(`  ${source.padEnd(30)} ${count} (${percentage}%)`);
    });
  console.log();

  // Show most recent issues
  console.log('Most recent issues (last 10):');
  console.log('-'.repeat(80));
  
  issues.slice(0, 10).forEach((issue, index) => {
    const date = new Date(issue.created_at);
    console.log(`\n${index + 1}. [${issue.type}] ${issue.source}`);
    console.log(`   ${issue.message}`);
    console.log(`   Time: ${date.toISOString()}`);
    
    if (issue.details) {
      try {
        const details = JSON.parse(issue.details);
        console.log(`   Details: ${JSON.stringify(details, null, 2).substring(0, 200)}...`);
      } catch {
        // Ignore JSON parse errors
      }
    }
  });

  console.log();
  console.log('='.repeat(80));
  console.log(`Report generated at: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
}

// Run the script
try {
  main();
} catch (error) {
  console.error('Error generating report:', error);
  process.exit(1);
}
