import Database from 'better-sqlite3';
import path from 'path';
import type { AnalysisResult } from '../services/AnalysisService';

// Use project root (src/db -> .. -> ..) so DB path does not depend on process.cwd() (PM2/backup-safe)
const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.join(projectRoot, 'bot.db');
const db = new Database(dbPath);

// Create tables if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS sent_news (
    id TEXT PRIMARY KEY,
    created_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    registered_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS data_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_events_created ON user_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_user_events_name_created ON user_events(event_name, created_at);
  
  CREATE TABLE IF NOT EXISTS ai_analysis_cache (
    event_key TEXT PRIMARY KEY,
    analysis TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Default monitored assets (major currencies only)
const DEFAULT_ASSETS = ['USD', 'EUR', 'GBP', 'JPY'];

export interface User {
  user_id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  registered_at: number;
}

export const database = {
  getDbPath: (): string => dbPath,

  // User management
  registerUser: (userId: number, username?: string, firstName?: string, lastName?: string): void => {
    db.prepare(`
      INSERT OR IGNORE INTO users (user_id, username, first_name, last_name, registered_at) 
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, username || null, firstName || null, lastName || null, Date.now());
  },
  
  getUsers: (): User[] => {
    return db.prepare('SELECT * FROM users').all() as User[];
  },

  getUserCount: (): number => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row?.count ?? 0;
  },

  getUserById: (userId: number): User | undefined => {
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as User | undefined;
  },
  
  // News tracking (global)
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
    db.prepare('DELETE FROM ai_analysis_cache WHERE created_at < ?').run(oneDayAgo);

    // Also cleanup old data issues (keep only last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM data_issues WHERE created_at < ?').run(sevenDaysAgo);
    
    // Cleanup old user_events (keep last 90 days)
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM user_events WHERE created_at < ?').run(ninetyDaysAgo);
  },

  // User analytics
  logUserEvent: (userId: number, eventType: 'command' | 'callback' | 'message', eventName: string): void => {
    try {
      db.prepare(
        'INSERT INTO user_events (user_id, event_type, event_name, created_at) VALUES (?, ?, ?, ?)'
      ).run(userId, eventType, eventName, Date.now());
    } catch (err) {
      console.warn('[DB] logUserEvent failed:', err instanceof Error ? err.message : err);
    }
  },

  getAnalyticsStats: (periodDays: number): {
    dau: number;
    wau: number;
    mau: number;
    totalUsers: number;
    featureUsage: Array<{ event_name: string; count: number }>;
  } => {
    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;
    const oneDayAgo = now - msDay;
    const sevenDaysAgo = now - 7 * msDay;
    const thirtyDaysAgo = now - 30 * msDay;

    const dau = (db.prepare(
      'SELECT COUNT(DISTINCT user_id) as c FROM user_events WHERE created_at >= ?'
    ).get(oneDayAgo) as { c: number })?.c ?? 0;

    const wau = (db.prepare(
      'SELECT COUNT(DISTINCT user_id) as c FROM user_events WHERE created_at >= ?'
    ).get(sevenDaysAgo) as { c: number })?.c ?? 0;

    const mau = (db.prepare(
      'SELECT COUNT(DISTINCT user_id) as c FROM user_events WHERE created_at >= ?'
    ).get(thirtyDaysAgo) as { c: number })?.c ?? 0;

    const totalUsers = database.getUserCount();

    const cutoff = now - periodDays * msDay;
    const featureRows = db.prepare(
      `SELECT event_name, COUNT(*) as count FROM user_events 
       WHERE created_at >= ? 
       GROUP BY event_name 
       ORDER BY count DESC 
       LIMIT 30`
    ).all(cutoff) as Array<{ event_name: string; count: number }>;

    return { dau, wau, mau, totalUsers, featureUsage: featureRows };
  },
  
  // Data quality issue tracking
  logDataIssue: (
    eventId: string | undefined,
    source: string,
    type: string,
    message: string,
    details?: Record<string, unknown>
  ) => {
    db.prepare(`
      INSERT INTO data_issues (event_id, source, type, message, details, created_at) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      eventId || null,
      source,
      type,
      message,
      details ? JSON.stringify(details) : null,
      Date.now()
    );
  },
  
  getRecentDataIssues: (limit: number = 100): Array<{
    id: number;
    event_id: string | null;
    source: string;
    type: string;
    message: string;
    details: string | null;
    created_at: number;
  }> => {
    return db.prepare('SELECT * FROM data_issues ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
        id: number;
        event_id: string | null;
        source: string;
        type: string;
        message: string;
        details: string | null;
        created_at: number;
      }>;
  },
  
  // User settings (per user)
  getMonitoredAssets: (userId: number): string[] => {
    const assetsKey = 'monitored_assets';
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, assetsKey) as { value: string } | undefined;
    
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
  
  toggleAsset: (userId: number, asset: string): boolean => {
    const currentAssets = database.getMonitoredAssets(userId);
    const isEnabled = currentAssets.includes(asset);
    
    let newAssets: string[];
    if (isEnabled) {
      newAssets = currentAssets.filter(a => a !== asset);
    } else {
      newAssets = [...currentAssets, asset];
    }
    
    database.setAssets(userId, newAssets);
    return !isEnabled;
  },
  
  setAssets: (userId: number, assets: string[]) => {
    const assetsKey = 'monitored_assets';
    const value = JSON.stringify(assets);
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(userId, assetsKey, value);
  },
  
  isRssEnabled: (userId: number): boolean => {
    const rssKey = 'RSS_ENABLED';
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, rssKey) as { value: string } | undefined;
    
    if (!row || !row.value) {
      return true; // Default to true if not set
    }
    return row.value === 'true';
  },
  
  toggleRss: (userId: number): boolean => {
    const rssKey = 'RSS_ENABLED';
    const currentState = database.isRssEnabled(userId);
    const newState = !currentState;
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(userId, rssKey, newState.toString());
    return newState;
  },
  
  isQuietHoursEnabled: (userId: number): boolean => {
    const quietHoursKey = 'QUIET_HOURS_ENABLED';
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, quietHoursKey) as { value: string } | undefined;
    
    if (!row || !row.value) {
      return true; // Default to true if not set
    }
    return row.value === 'true';
  },
  
  toggleQuietHours: (userId: number): boolean => {
    const quietHoursKey = 'QUIET_HOURS_ENABLED';
    const currentState = database.isQuietHoursEnabled(userId);
    const newState = !currentState;
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(userId, quietHoursKey, newState.toString());
    return newState;
  },
  
  // News source settings
  getNewsSource: (userId: number): 'ForexFactory' | 'Myfxbook' | 'Both' => {
    const sourceKey = 'news_source';
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, sourceKey) as { value: string } | undefined;
    
    if (!row || !row.value) {
      return 'Both'; // Default to both sources
    }
    
    const value = row.value as 'ForexFactory' | 'Myfxbook' | 'Both';
    if (value === 'ForexFactory' || value === 'Myfxbook' || value === 'Both') {
      return value;
    }
    return 'Both';
  },
  
  setNewsSource: (userId: number, source: 'ForexFactory' | 'Myfxbook' | 'Both'): void => {
    const sourceKey = 'news_source';
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(userId, sourceKey, source);
  },

  // User timezone (IANA, e.g. Europe/Kyiv). Used for quiet hours and time display.
  getTimezone: (userId: number): string => {
    const tzKey = 'user_timezone';
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, tzKey) as { value: string } | undefined;
    if (!row || !row.value) {
      return 'Europe/Kyiv';
    }
    return row.value;
  },

  setTimezone: (userId: number, timezone: string): void => {
    const tzKey = 'user_timezone';
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(userId, tzKey, timezone);
  },

  getCachedAnalysis: (eventKey: string): AnalysisResult | null => {
    const row = db.prepare(
      'SELECT analysis FROM ai_analysis_cache WHERE event_key = ? AND created_at > ?'
    ).get(eventKey, Date.now() - 24 * 60 * 60 * 1000) as { analysis: string } | undefined;
    return row ? (JSON.parse(row.analysis) as AnalysisResult) : null;
  },

  setCachedAnalysis: (eventKey: string, result: AnalysisResult): void => {
    db.prepare(
      'INSERT OR REPLACE INTO ai_analysis_cache (event_key, analysis, created_at) VALUES (?, ?, ?)'
    ).run(eventKey, JSON.stringify(result), Date.now());
  },
};
