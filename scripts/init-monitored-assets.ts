import { database } from '../src/db/database';

/**
 * Initialize monitored assets with default currencies
 */
function initMonitoredAssets() {
  console.log('=== Initializing Monitored Assets ===\n');
  
  // Default currencies based on user's preferences
  const currencies = [
    { currency: 'USD', enabled: true },  // US Dollar - most important!
    { currency: 'EUR', enabled: true },  // Euro
    { currency: 'GBP', enabled: true },  // British Pound
    { currency: 'JPY', enabled: true },  // Japanese Yen
    { currency: 'AUD', enabled: true },  // Australian Dollar
    { currency: 'CAD', enabled: true },  // Canadian Dollar
    { currency: 'CHF', enabled: true },  // Swiss Franc
    { currency: 'NZD', enabled: true },  // New Zealand Dollar
    { currency: 'CNY', enabled: false }, // Chinese Yuan (optional)
  ];
  
  console.log('Current monitored assets:');
  const current = database.getMonitoredAssets();
  console.log(current.length > 0 ? current.join(', ') : 'EMPTY!\n');
  
  console.log('\nAdding currencies to database:');
  currencies.forEach(({ currency, enabled }) => {
    if (enabled) {
      database.addMonitoredAsset(currency);
      console.log(`✓ Added: ${currency}`);
    } else {
      console.log(`- Skipped: ${currency} (disabled)`);
    }
  });
  
  console.log('\nFinal monitored assets:');
  const final = database.getMonitoredAssets();
  console.log(final.join(', '));
  
  console.log(`\n✅ Done! Monitoring ${final.length} currencies.`);
}

initMonitoredAssets();
