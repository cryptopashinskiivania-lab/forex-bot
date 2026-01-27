import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'bot.db'));

// Create tables if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS sent_news (
    id TEXT PRIMARY KEY,
    created_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Default monitored assets
const DEFAULT_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'];

// Initialize default assets if not set
const assetsKey = 'monitored_assets';
const existingAssets = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(assetsKey);
if (!existingAssets) {
  db.prepare('INSERT INTO user_settings (key, value) VALUES (?, ?)').run(assetsKey, JSON.stringify(DEFAULT_ASSETS));
}

export const database = {
  hasSent: (id: string): boolean => {
    const row = db.prepare('SELECT id FROM sent_news WHERE id = ?').get(id);
    return !!row;
  },
  markAsSent: (id: string) => {
    db.prepare('INSERT OR IGNORE INTO sent_news (id, created_at) VALUES (?, ?)').run(id, Date.now());
  },
  cleanup: () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM sent_news WHERE created_at < ?').run(oneDayAgo);
  },
  getMonitoredAssets: (): string[] => {
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(assetsKey) as { value: string } | undefined;
    if (!row || !row.value) {
      return DEFAULT_ASSETS;
    }
    try {
      const assets = JSON.parse(row.value) as string[];
      return Array.isArray(assets) ? assets : DEFAULT_ASSETS;
    } catch {
      return DEFAULT_ASSETS;
    }
  },
  toggleAsset: (asset: string): boolean => {
    const currentAssets = database.getMonitoredAssets();
    const isEnabled = currentAssets.includes(asset);
    
    let newAssets: string[];
    if (isEnabled) {
      newAssets = currentAssets.filter(a => a !== asset);
    } else {
      newAssets = [...currentAssets, asset];
    }
    
    database.setAssets(newAssets);
    return !isEnabled;
  },
  setAssets: (assets: string[]) => {
    const value = JSON.stringify(assets);
    db.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)').run(assetsKey, value);
  },
  isRssEnabled: (): boolean => {
    const rssKey = 'RSS_ENABLED';
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(rssKey) as { value: string } | undefined;
    if (!row || !row.value) {
      // Default to true if not set
      return true;
    }
    return row.value === 'true';
  },
  toggleRss: (): boolean => {
    const rssKey = 'RSS_ENABLED';
    const currentState = database.isRssEnabled();
    const newState = !currentState;
    db.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)').run(rssKey, newState.toString());
    return newState;
  },
  isQuietHoursEnabled: (): boolean => {
    const quietHoursKey = 'QUIET_HOURS_ENABLED';
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(quietHoursKey) as { value: string } | undefined;
    if (!row || !row.value) {
      // Default to true if not set
      return true;
    }
    return row.value === 'true';
  },
  toggleQuietHours: (): boolean => {
    const quietHoursKey = 'QUIET_HOURS_ENABLED';
    const currentState = database.isQuietHoursEnabled();
    const newState = !currentState;
    db.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)').run(quietHoursKey, newState.toString());
    return newState;
  }
};
