// language: JavaScript, file: public/js/builder.js
const $ = (id) => document.getElementById(id);

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

async function loadBases() {
  const r = await fetch('/api/build/bases');
  if (!r.ok) return;
  const bases = await r.json();
  const sel = $('b-base');
  const prev = sel.value;
  sel.innerHTML = '';
  if (bases.length === 0) {
    sel.innerHTML = '<option value="">no bases in exe/ — drop an exe there</option>';
    return;
  }
  bases.forEach(b => {
    const o = document.createElement('option');
    o.value = b.name;
    o.textContent = `${b.name} (${humanSize(b.size)})`;
    sel.appendChild(o);
  });
  if (prev && bases.some(b => b.name === prev)) sel.value = prev;
}

async function loadBuilds() {
  const r = await fetch('/api/builds');
  if (!r.ok) return;
  const rows = await r.json();
  $('b-count').textContent = `${rows.length} builds`;
  const host = $('b-rows');
  host.innerHTML = '';
  if (rows.length === 0) {
    host.innerHTML = '<div class="empty">no builds yet</div>';
    return;
  }
  rows.forEach(b => {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <span class="dot on"></span>
      <span class="host">${esc(b.base)}</span>
      <span class="ip">${humanSize(b.size)}</span>
      <span class="seen">${new Date(b.created_at).toLocaleString()}</span>
      <span class="actions">
        <button class="ghost mini" data-dl>download</button>
        <button class="ghost mini" data-del style="border-color:var(--red);color:var(--red)">delete</button>
      </span>`;
    el.querySelector('[data-dl]').addEventListener('click', (e) => {
      e.stopPropagation();
      location.href = `/api/builds/${b.id}/download`;
    });
    el.querySelector('[data-del]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`delete build of ${b.base}?`)) return;
      await fetch(`/api/builds/${b.id}`, { method: 'DELETE' });
      loadBuilds();
    });
    host.appendChild(el);
  });
}

$('b-build').addEventListener('click', async () => {
  const base = $('b-base').value;
  const key = $('b-key').value.trim();
  let config;
  try { config = JSON.parse($('b-config').value || '{}'); }
  catch {
    $('b-result').innerHTML = '<div class="err">config is not valid json</div>';
    return;
  }

  if (!base) {
    $('b-result').innerHTML = '<div class="err">pick a base exe first — drop one in exe/</div>';
    return;
  }

  $('b-build').disabled = true;
  $('b-build').textContent = 'building…';
  $('b-result').innerHTML = '';

  try {
    const r = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, key, config }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      $('b-result').innerHTML = `<div class="err">${esc(d.error || 'build failed')}</div>`;
    } else {
      $('b-result').innerHTML = `
        <div class="tile">
          <div class="k">build ready</div>
          <div class="v mono" style="font-size:13px;margin-top:8px">${esc(d.key)}</div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="ghost mini" id="b-dl">download zip</button>
          </div>
          <div class="note">zip contains ${esc(base)} + key.json. extract and run the exe.</div>
        </div>`;
      $('b-dl').addEventListener('click', () => { location.href = d.url; });
      loadBuilds();
    }
  } catch {
    $('b-result').innerHTML = '<div class="err">network error</div>';
  }

  $('b-build').disabled = false;
  $('b-build').textContent = 'build';
});

$('b-refresh').addEventListener('click', () => { loadBases(); loadBuilds(); });

// populate on first paint too — the script is loaded on the dashboard page
loadBases();
loadBuilds();