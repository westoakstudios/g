// language: JavaScript, file: public/js/signin.js
const $ = (id) => document.getElementById(id);
let mode = 'token';

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('m-user').style.display  = mode === 'user'  ? '' : 'none';
    $('m-token').style.display = mode === 'token' ? '' : 'none';
    $('err').textContent = '';
  });
});

async function go() {
  $('err').textContent = '';
  let body;
  if (mode === 'token') {
    const tok = $('token').value.trim();
    if (!tok) { $('err').textContent = 'enter your login token'; return; }
    body = { loginToken: tok };
  } else {
    const u = $('username').value.trim();
    const p = $('password').value;
    if (!u || !p) { $('err').textContent = 'enter username and password'; return; }
    body = { username: u, password: p };
  }

  $('go').disabled = true;
  $('go').textContent = 'signing in…';
  try {
    const r = await fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      $('err').textContent = d.error || 'signin failed';
      $('go').disabled = false;
      $('go').textContent = 'sign in';
      return;
    }
    location.href = '/dashboard.html';
  } catch {
    $('err').textContent = 'network error';
    $('go').disabled = false;
    $('go').textContent = 'sign in';
  }
}

$('go').addEventListener('click', go);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });