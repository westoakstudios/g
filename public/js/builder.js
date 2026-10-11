// language: JavaScript, file: public/js/builder.js
// builder tab — self-bootstrapping, loads on DOMContentLoaded

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function humanSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function loadBases() {
    const sel = $('b-base');
    if (!sel) return;
    sel.innerHTML = '<option value="">loading…</option>';

    try {
      const r = await fetch('/api/build/bases', { credentials: 'same-origin' });
      if (!r.ok) {
        sel.innerHTML = `<option value="">error ${r.status}</option>`;
        return;
      }
      const bases = await r.json();
      const prev = sel.value;
      sel.innerHTML = '';
      if (!bases || bases.length === 0) {
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
    } catch (e) {
      sel.innerHTML = '<option value="">network error</option>';
    }
  }

  async function loadBuilds() {
    const host = $('b-rows');
    if (!host) return;

    try {
      const r = await fetch('/api/builds', { credentials: 'same-origin' });
      if (!r.ok) return;
      const rows = await r.json();

      const count = $('b-count');
      if (count) count.textContent = `${rows.length} builds`;

      host.innerHTML = '';
      if (!rows || rows.length === 0) {
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
          window.location.href = `/api/builds/${b.id}/download`;
        });
        el.querySelector('[data-del]').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`delete build of ${b.base}?`)) return;
          await fetch(`/api/builds/${b.id}`, { method: 'DELETE', credentials: 'same-origin' });
          loadBuilds();
        });
        host.appendChild(el);
      });
    } catch (e) { /* silent */ }
  }

  async function doBuild() {
    const btn = $('b-build');
    const out = $('b-result');
    if (!btn || !out) return;

    const base = $('b-base')?.value;
    const key  = $('b-key')?.value.trim() || '';
    let config;

    try {
      config = JSON.parse($('b-config')?.value || '{}');
    } catch {
      out.innerHTML = '<div class="err">config is not valid json</div>';
      return;
    }

    if (!base) {
      out.innerHTML = '<div class="err">pick a base exe first — drop one in exe/</div>';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'building…';
    out.innerHTML = '';

    try {
      const r = await fetch('/api/build', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, key, config }),
      });
      const d = await r.json().catch(() => ({}));

      if (!r.ok) {
        out.innerHTML = `<div class="err">${esc(d.error || ('build failed: ' + r.status))}</div>`;
      } else {
        out.innerHTML = `
          <div class="tile">
            <div class="k">build ready</div>
            <div class="v mono" style="font-size:13px;margin-top:8px">${esc(d.key)}</div>
            <div style="display:flex;gap:8px;margin-top:14px">
              <button class="ghost mini" id="b-dl-now">download zip</button>
            </div>
            <div class="note">zip contains ${esc(base)} + key.json. extract and run the exe.</div>
          </div>`;
        const dlBtn = document.getElementById('b-dl-now');
        if (dlBtn) dlBtn.addEventListener('click', () => { window.location.href = d.url; });
        loadBuilds();
      }
    } catch (e) {
      out.innerHTML = '<div class="err">network error — check the server log</div>';
    }

    btn.disabled = false;
    btn.textContent = 'build';
  }

  function wire() {
    const buildBtn = $('b-build');
    const refreshBtn = $('b-refresh');
    if (buildBtn)   buildBtn.addEventListener('click', doBuild);
    if (refreshBtn) refreshBtn.addEventListener('click', () => { loadBases(); loadBuilds(); });
  }

  function boot() {
    // only run on the dashboard (elements exist), and only once
    if (!$('b-base')) return;
    if (window.__builderBooted) return;
    window.__builderBooted = true;

    wire();
    loadBases();
    loadBuilds();

    // refresh bases every time the builder tab is clicked
    const navBuilder = document.querySelector('.nav a[data-tab="builder"]');
    if (navBuilder) {
      navBuilder.addEventListener('click', () => {
        setTimeout(() => { loadBases(); loadBuilds(); }, 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();