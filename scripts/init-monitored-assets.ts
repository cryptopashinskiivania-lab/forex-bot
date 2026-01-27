import { database } from '../src/db/database';

/**
 * Initialize monitored assets with default currencies
 */
function initMonitoredAssets() {
  console.log('=== Initializing Monitored Assets ===\n');
  
  // Default currencies - only major pairs enabled by default
  const currencies = [
    { currency: 'USD', enabled: true },  // US Dollar - most important!
    { currency: 'EUR', enabled: true },  // Euro
    { currency: 'GBP', enabled: true },  // British Pound
    { currency: 'JPY', enabled: true },  // Japanese Yen
    { currency: 'AUD', enabled: false }, // Australian Dollar (disabled by default)
    { currency: 'CAD', enabled: false }, // Canadian Dollar (disabled by default)
    { currency: 'CHF', enabled: false }, // Swiss Franc (disabled by default)
    { currency: 'NZD', enabled: false }, // New Zealand Dollar (disabled by default)
    { currency: 'CNY', enabled: false }, // Chinese Yuan (disabled by default)
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
