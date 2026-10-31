// language: JavaScript, file: remote_db.js
import mysql from 'mysql2/promise';
import fs from 'node:fs';

const DB_NAME = 'weedhack';

const DB_CONFIG = {
  host: 'gateway01.eu-central-1.prod.aws.tidbcloud.com',
  port: 4000,
  user: '4Dosrowwv3DgbU6.root',
  password: 'HuXBzVJiMf8Sz4YL',
  waitForConnections: true,
  connectionLimit: 10,
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

export const remoteDb = mysql.createPool({
  ...DB_CONFIG,
  database: DB_NAME
});

export async function initRemoteDb() {
  try {
    const tempConn = await mysql.createConnection(DB_CONFIG);
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await tempConn.end();
  } catch (e) {
    console.error(`[remote_db] Failed to create DB:`, e.message);
  }

  await remoteDb.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      username      VARCHAR(255) UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      account_key   VARCHAR(255) UNIQUE NOT NULL,
      login_token   VARCHAR(255) UNIQUE,
      discord_webhook TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      premium_until BIGINT DEFAULT 0
    );
  `);
  
  try {
    await remoteDb.query(`CREATE INDEX IF NOT EXISTS idx_users_key ON users(account_key);`);
    await remoteDb.query(`CREATE INDEX IF NOT EXISTS idx_users_login ON users(login_token);`);
  } catch (e) {}
}