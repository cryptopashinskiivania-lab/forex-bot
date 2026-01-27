/**
 * Check what assets are in the database
 */
import { database } from '../src/db/database';

const assets = database.getMonitoredAssets();
console.log('Monitored assets from database:', assets);
console.log('Total:', assets.length);
