// language: JavaScript, file: public/js/procs.js
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = Number(params.get('id'));
const hostName = params.get('host') || `client ${clientId}`;
const hostIp   = params.get('ip') || '';
$('target').textContent = `${hostName} @ ${hostIp}`;

let polling = false;
let state = {
  sortBy: 'cpu',
  data: null
};

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

async function killProcess(pid, name) {
  if (!confirm(`Are you sure you want to kill ${name} (PID: ${pid})?`)) return;
  
  $('status').textContent = `killing ${pid}…`;
  try {
    const r = await fetch(`/api/clients/${clientId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell: 'cmd', line: `taskkill /F /PID ${pid}` }),
    });
    if (!r.ok) throw new Error('request failed');
    
    // wait a second for the OS to process the kill, then refresh
    setTimeout(poll, 1000);
  } catch (e) {
    alert(`Failed to kill process: ${e.message}`);
    $('status').textContent = 'kill failed';
  }
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
      if (d.raw) console.error('Raw output:', d.raw);
      return;
    }
    state.data = d;
    render();
    $('status').textContent = `updated ${new Date(d.ts).toLocaleTimeString()}`;
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
  } finally {
    polling = false;
  }
}

function render() {
  if (!state.data) return;
  const d = state.data;
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
    $('gpu-mem').textContent = (g.mem_total_mb ? `${fmtMb(g.mem_used_mb)} / ${fmtMb(g.mem_total_mb)} vram` : 'no vram data');
    $('gpu-src').textContent = g.source || '';
  } else {
    $('gpu').textContent = '—';
    $('gpu-bar').innerHTML = bar(0, '#fbbf24');
    $('gpu-mem').textContent = 'no gpu data';
    $('gpu-src').textContent = '';
  }

  const body = $('proc-body');
  body.innerHTML = '';
  
  let procs = Array.isArray(d.procs) ? d.procs.slice() : [];
  if (!procs.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">no processes</td></tr>';
    return;
  }

  // Sort logic based on clicks
  if (state.sortBy === 'cpu') {
    procs.sort((a, b) => (Number(b.cpu_pct) || 0) - (Number(a.cpu_pct) || 0));
  } else if (state.sortBy === 'ram') {
    procs.sort((a, b) => (Number(b.ram_mb) || 0) - (Number(a.ram_mb) || 0));
  }

  for (const p of procs) {
    const tr = document.createElement('tr');
    const cpuPctStr = p.cpu_pct != null ? `${Number(p.cpu_pct).toFixed(1)}%` : '—';
    const cpuTotal  = p.cpu_s  != null ? `${Number(p.cpu_s).toFixed(1)}s` : '—';
    tr.innerHTML = `
      <td class="pname">${esc(p.name)}</td>
      <td class="pid">${p.pid}</td>
      <td class="pnum">${fmtMb(p.ram_mb)}</td>
      <td class="pnum">${cpuPctStr}</td>
      <td class="pnum">${cpuTotal}</td>
      <td class="paction"><button class="kill-btn" title="Kill Process">✕</button></td>`;
      
    const btn = tr.querySelector('.kill-btn');
    btn.addEventListener('click', () => killProcess(p.pid, p.name));
    
    body.appendChild(tr);
  }
}

// wire up gauge clicks
document.querySelectorAll('.gauge').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.gauge').forEach(g => g.classList.remove('active'));
    el.classList.add('active');
    
    let sortType = el.dataset.sort;
    if (sortType === 'gpu') {
      // GPU is system-wide, fallback to CPU sorting for processes
      sortType = 'cpu';
    }
    
    state.sortBy = sortType;
    render();
  });
});

$('refresh').addEventListener('click', poll);
$('close').addEventListener('click', () => window.close());

poll();
setInterval(poll, 5000);