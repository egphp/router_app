import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  const cfg = loadConfig();
  const target = dbPath ?? cfg.dbPath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function runMigrations(): void {
  const db = getDb();
  const migrationsDir = path.resolve(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (file TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.prepare(`SELECT file FROM _migrations`).all().map((r: any) => r.file));
  const insertMig = db.prepare(`INSERT INTO _migrations(file, applied_at) VALUES (?, ?)`);
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    insertMig.run(file, Date.now());
    console.log(`[migrate] applied ${file}`);
  }
}
