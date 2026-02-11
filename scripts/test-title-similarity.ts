/**
 * Test titleSimilarity function
 */

import crypto from 'crypto';

function titleSimilarity(title1: string, title2: string): number {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t1 = clean(title1);
  const t2 = clean(title2);
  
  if (t1 === t2) return 1.0;
  
  // Simple Levenshtein-like comparison (can be enhanced)
  const longer = t1.length > t2.length ? t1 : t2;
  const shorter = t1.length > t2.length ? t2 : t1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = [...longer].reduce((acc, char, i) => {
    return shorter[i] === char ? acc : acc + 1;
  }, 0);
  
  return (longer.length - editDistance) / longer.length;
}

console.log('=== Testing titleSimilarity ===\n');

const testPairs = [
  ['Non-Farm Payrolls', 'NFP'],
  ['Non-Farm Payrolls', 'Non-Farm Payrolls'],
  ['NFP', 'nonfarm payrolls'],
  ['Unemployment Rate', 'Unemployment Rate'],
  ['CPI y/y', 'CPI'],
];

testPairs.forEach(([title1, title2]) => {
  const similarity = titleSimilarity(title1, title2);
  const status = similarity > 0.7 ? '✅ Similar' : '❌ Not similar';
  console.log(`${status} (${(similarity * 100).toFixed(1)}%)`);
  console.log(`  "${title1}" vs "${title2}"`);
  console.log(`  Cleaned: "${title1.toLowerCase().replace(/[^a-z0-9]/g, '')}" vs "${title2.toLowerCase().replace(/[^a-z0-9]/g, '')}"`);
  console.log('');
});

console.log('\n=== Analysis ===');
console.log('Issue: The current algorithm compares character by character at same positions.');
console.log('This fails for abbreviations like "NFP" vs "Non-Farm Payrolls".');
console.log('Recommendation: Use substring containment or proper Levenshtein distance.');
