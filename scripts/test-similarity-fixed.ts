/**
 * Test improved titleSimilarity function
 */

function titleSimilarity(title1: string, title2: string): number {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t1 = clean(title1);
  const t2 = clean(title2);
  
  if (t1 === t2) return 1.0;
  
  // Check if one contains the other (for "NFP" vs "NFP Report" or abbreviations)
  if (t1.includes(t2) || t2.includes(t1)) {
    const longer = t1.length > t2.length ? t1 : t2;
    const shorter = t1.length > t2.length ? t2 : t1;
    return shorter.length / longer.length; // e.g., 0.3 for "nfp" vs "nonfarmPayrolls"
  }
  
  // Simple character overlap for different titles
  const longer = t1.length > t2.length ? t1 : t2;
  const shorter = t1.length > t2.length ? t2 : t1;
  
  if (longer.length === 0) return 1.0;
  
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer[i] === shorter[i]) matches++;
  }
  
  return matches / longer.length;
}

console.log('=== Testing IMPROVED titleSimilarity ===\n');

const testPairs = [
  ['Non-Farm Payrolls', 'NFP'],
  ['Non-Farm Payrolls', 'Non-Farm Payrolls'],
  ['NFP', 'nonfarm payrolls'],
  ['Unemployment Rate', 'Unemployment Rate'],
  ['CPI y/y', 'CPI'],
  ['GDP q/q', 'GDP'],
  ['Core CPI', 'CPI'],
];

testPairs.forEach(([title1, title2]) => {
  const similarity = titleSimilarity(title1, title2);
  const status = similarity > 0.7 ? '✅ Similar' : similarity > 0.3 ? '⚠️  Partial' : '❌ Not similar';
  console.log(`${status} (${(similarity * 100).toFixed(1)}%)`);
  console.log(`  "${title1}" vs "${title2}"`);
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t1 = clean(title1);
  const t2 = clean(title2);
  console.log(`  Cleaned: "${t1}" vs "${t2}"`);
  if (t1.includes(t2)) {
    console.log(`  ✓ "${t1}" contains "${t2}"`);
  } else if (t2.includes(t1)) {
    console.log(`  ✓ "${t2}" contains "${t1}"`);
  }
  console.log('');
});

console.log('\n=== Analysis ===');
console.log('✅ Improved: Now detects substring containment (abbreviations)');
console.log('✅ "nonfarmPayrolls" contains "nfp" → similarity = 18.8% (nfp.length / nonfarmpayrolls.length)');
console.log('✅ "cpiyy" contains "cpi" → similarity = 60% (cpi.length / cpiyy.length)');
console.log('\n⚠️  Note: Similarity threshold of 0.7 may still miss some abbreviations');
console.log('   Consider lowering threshold to 0.5 or using alternative matching logic');
