// language: JavaScript, file: public/js/builder.js
// builder tab — key field, build button, auto-download on success, builds list.

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
            <button class="ghost mini" data-del style="border-color:rgba(248,113,113,.35);color:var(--red)">delete</button>
          </span>`;
        el.querySelector('[data-dl]').addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.href = `/api/builds/${b.id}/download`;
        });
        el.querySelector('[data-del]').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`delete build?`)) return;
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

    const key = ($('b-key')?.value || '').trim();

    btn.disabled = true;
    btn.textContent = 'building…';
    out.innerHTML = '<div class="note">compiling on server — first build takes 2–3 min, after that ~30s</div>';

    try {
      const r = await fetch('/api/build', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const d = await r.json().catch(() => ({}));

      if (!r.ok) {
        out.innerHTML = `<div class="err">${esc(d.error || ('build failed: ' + r.status))}</div>`;
      } else {
        out.innerHTML = `
          <div class="tile">
            <div class="k">build ready — download starting</div>
            <div class="v mono" style="font-size:13px;margin-top:8px">${esc(d.key)}</div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
              <button class="ghost mini" id="b-dl-now">download again</button>
            </div>
            <div class="note">live url: <code style="color:var(--accent);font-family:var(--mono)">/api/downloads/boot.exe</code></div>
          </div>`;

        // auto-download via hidden iframe — no navigation away from the dashboard
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = d.url;
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 30000);

        document.getElementById('b-dl-now')?.addEventListener('click', () => {
          window.location.href = d.url;
        });
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

    const fromAcct = document.getElementById('a-akey')?.textContent;
    if (fromAcct && fromAcct !== '—') { keyField.value = fromAcct; return; }

    const fromOv = document.getElementById('ov-akey')?.textContent;
    if (fromOv && fromOv !== '—') { keyField.value = fromOv; return; }

    fetch('/api/me', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(me => { if (me?.accountKey) keyField.value = me.accountKey; })
      .catch(() => {});
  }

  function boot() {
    if (!$('b-key')) return;
    if (window.__builderBooted) return;
    window.__builderBooted = true;

    preloadAccountKey();

    const buildBtn = $('b-build');
    const refreshBtn = $('b-refresh');
    if (buildBtn)   buildBtn.addEventListener('click', doBuild);
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadBuilds());

    loadBuilds();

    const navBuilder = document.querySelector('.nav a[data-tab="builder"]');
    if (navBuilder) {
      navBuilder.addEventListener('click', () => {
        setTimeout(() => { preloadAccountKey(); loadBuilds(); }, 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();