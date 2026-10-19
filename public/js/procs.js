// language: JavaScript, file: public/js/procs.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';
$('target').textContent = `${hostName} @ ${hostIp}`;

let polling = false;

function fmtMb(n) {
  if (n == null || n === 0) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(2)} GB`;
  return `${Math.round(n)} MB`;
}

function bar(pct, color) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="gauge-bar"><div class="gauge-fill" style="width:${p}%; background:${color};"></div></div>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function poll() {
  if (polling) return;
  polling = true;
  $('status').textContent = 'sampling…';
  try {
    const r = await fetch(`/api/clients/${clientId}/sysinfo`, { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      $('status').textContent = `error: ${d.error || r.status}`;
      return;
    }
    render(d);
    $('status').textContent = `updated ${new Date(d.ts).toLocaleTimeString()}`;
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
  } finally {
    polling = false;
  }
}

function render(d) {
  const cpuPct = Number(d.cpu) || 0;
  const ramPct = Number(d.ram?.percent) || 0;

  $('cpu').textContent = `${cpuPct.toFixed(1)}%`;
  $('cpu-bar').innerHTML = bar(cpuPct, '#6cb6ff');
  $('cores').textContent = d.cores ? `${d.cores} logical cores` : '—';

  $('ram-pct').textContent = `${ramPct.toFixed(1)}%`;
  $('ram-bar').innerHTML = bar(ramPct, '#4ade80');
  $('ram-used').textContent = fmtMb(d.ram?.used_mb);
  $('ram-total').textContent = fmtMb(d.ram?.total_mb);

  const g = d.gpu;
  if (g && g.util != null) {
    $('gpu').textContent = `${Number(g.util).toFixed(1)}%`;
    $('gpu-bar').innerHTML = bar(g.util, '#fbbf24');
    $('gpu-mem').textContent = (g.mem_total_mb
      ? `${fmtMb(g.mem_used_mb)} / ${fmtMb(g.mem_total_mb)} vram`
      : 'no vram data');
    $('gpu-src').textContent = g.source || '';
  } else {
    $('gpu').textContent = '—';
    $('gpu-bar').innerHTML = bar(0, '#fbbf24');
    $('gpu-mem').textContent = 'no gpu data';
    $('gpu-src').textContent = '';
  }

  const body = $('proc-body');
  body.innerHTML = '';
  const procs = Array.isArray(d.procs) ? d.procs : [];
  if (!procs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">no processes</td></tr>';
    return;
  }
  for (const p of procs.slice(0, 50)) {
    const tr = document.createElement('tr');
    const cpuPctStr = p.cpu_pct != null ? `${Number(p.cpu_pct).toFixed(1)}%` : '—';
    const cpuTotal  = p.cpu_s  != null ? `${Number(p.cpu_s).toFixed(1)}s` : '—';
    tr.innerHTML = `
      <td class="pname">${esc(p.name)}</td>
      <td class="pid">${p.pid}</td>
      <td class="pnum">${fmtMb(p.ram_mb)}</td>
      <td class="pnum">${cpuPctStr}</td>
      <td class="pnum">${cpuTotal}</td>`;
    body.appendChild(tr);
  }
}

$('refresh').addEventListener('click', poll);
$('close').addEventListener('click', () => window.close());

poll();
setInterval(poll, 5000);