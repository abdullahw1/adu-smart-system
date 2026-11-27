import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';

let database;
export function db() {
  if (database) return database;
  const dir = process.env.APP_DATA_DIR || path.join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'app.sqlite');
  database = new DatabaseSync(file);
  chmodSync(file, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);`);
  // Import existing per-install preferences once; transactions also protect
  // against concurrent Next.js workers initializing their connections.
  for (const [name, prefix] of [['camera-names.json', 'name:'], ['camera-settings.json', 'prefs:']]) {
    if (database.prepare('SELECT name FROM migrations WHERE name=?').get(name)) continue;
    let old;
    try { old = JSON.parse(readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; old = {}; }
    database.exec('BEGIN IMMEDIATE');
    try {
      if (!database.prepare('SELECT name FROM migrations WHERE name=?').get(name)) {
        for (const [id, value] of Object.entries(old)) {
          database.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(prefix + id, JSON.stringify(value));
        }
        database.prepare('INSERT INTO migrations VALUES (?)').run(name);
      }
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  return database;
}

export function readSetting(key, fallback = null) {
  const row = db().prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function allSettings(prefix) {
  return Object.fromEntries(db().prepare('SELECT key,value FROM settings WHERE key LIKE ?').all(prefix + '%')
    .map(row => [row.key.slice(prefix.length), JSON.parse(row.value)]));
}
export function writeSetting(key, value, merge = false) {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const next = merge ? { ...readSetting(key, {}), ...value } : value;
    database.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(next));
    database.exec('COMMIT');
    return next;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
