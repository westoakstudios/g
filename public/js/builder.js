// language: JavaScript, file: public/js/builder.js
// builder tab — key optional. empty key → server falls back to your account key.

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
      if (!r.ok) { sel.innerHTML = `<option value="">error ${r.status}</option>`; return; }
      const bases = await r.json();
      const prev = sel.value;
      sel.innerHTML = '';
      if (!bases || bases.length === 0) {
        sel.innerHTML = '<option value="">no bases in exe/</option>';
        return;
      }
      bases.forEach(b => {
        const o = document.createElement('option');
        o.value = b.name;
        o.textContent = `${b.name} (${humanSize(b.size)})`;
        sel.appendChild(o);
      });
      if (prev && bases.some(b => b.name === prev)) sel.value = prev;
    } catch { sel.innerHTML = '<option value="">network error</option>'; }
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
    } catch {}
  }

  async function doBuild() {
    const btn = $('b-build');
    const out = $('b-result');
    if (!btn || !out) return;

    const base = $('b-base')?.value;
    const key  = ($('b-key')?.value || '').trim();   // may be empty — server falls back

    if (!base) {
      out.innerHTML = '<div class="err">pick a base exe first</div>';
      return;
    }

    let config;
    try {
      config = JSON.parse($('b-config')?.value || '{}');
    } catch {
      out.innerHTML = '<div class="err">config is not valid json</div>';
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
            <div class="k">build ready — key baked in</div>
            <div class="v mono" style="font-size:13px;margin-top:8px">${esc(d.key)}</div>
            <div style="display:flex;gap:8px;margin-top:14px">
              <button class="ghost mini" id="b-dl-now">download exe</button>
            </div>
            <div class="note">single exe · config baked in · ${humanSize(d.size)}</div>
          </div>`;
        const dlBtn = document.getElementById('b-dl-now');
        if (dlBtn) dlBtn.addEventListener('click', () => { window.location.href = d.url; });
        loadBuilds();
      }
    } catch {
      out.innerHTML = '<div class="err">network error</div>';
    }

    btn.disabled = false;
    btn.textContent = 'build';
  }

  function preloadAccountKey() {
    const keyField = $('b-key');
    if (!keyField || keyField.value) return;

    // try #a-akey dataset first (account tab), then #ov-akey text, then /api/me
    const fromAcct = document.getElementById('a-akey')?.dataset?.real;
    if (fromAcct && fromAcct !== '—') { keyField.value = fromAcct; return; }

    const fromOv = document.getElementById('ov-akey')?.textContent;
    if (fromOv && fromOv !== '—' && !fromOv.startsWith('•')) { keyField.value = fromOv; return; }

    fetch('/api/me', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(me => { if (me?.accountKey) keyField.value = me.accountKey; })
      .catch(() => {});
  }

  function wire() {
    const buildBtn = $('b-build');
    const refreshBtn = $('b-refresh');
    if (buildBtn)   buildBtn.addEventListener('click', doBuild);
    if (refreshBtn) refreshBtn.addEventListener('click', () => { loadBases(); loadBuilds(); });
  }

  function boot() {
    if (!$('b-base')) return;
    if (window.__builderBooted) return;
    window.__builderBooted = true;

    preloadAccountKey();
    wire();
    loadBases();
    loadBuilds();

    const navBuilder = document.querySelector('.nav a[data-tab="builder"]');
    if (navBuilder) {
      navBuilder.addEventListener('click', () => {
        setTimeout(() => { preloadAccountKey(); loadBases(); loadBuilds(); }, 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();