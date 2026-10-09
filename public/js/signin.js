// language: JavaScript, file: public/js/signin.js
const $ = (id) => document.getElementById(id);
let mode = 'user';

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('m-user').style.display  = mode === 'user'  ? '' : 'none';
    $('m-token').style.display = mode === 'token' ? '' : 'none';
  });
});

$('go').addEventListener('click', async () => {
  $('err').textContent = '';
  const body = { password: $('password').value };
  if (mode === 'token') body.loginToken = $('token').value.trim();
  else body.username = $('username').value.trim();

  try {
    const r = await fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('err').textContent = d.error || 'signin failed'; return; }
    location.href = '/dashboard.html';
  } catch {
    $('err').textContent = 'network error';
  }
});