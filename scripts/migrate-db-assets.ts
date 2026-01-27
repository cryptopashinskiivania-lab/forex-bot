/**
 * Migrate database to include new assets (CAD, AUD, CHF)
 */
import { database } from '../src/db/database';

console.log('Current assets:', database.getMonitoredAssets());

// Update to new default set
const NEW_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'];
database.setAssets(NEW_ASSETS);

console.log('Updated assets:', database.getMonitoredAssets());
console.log('✅ Migration complete!');
