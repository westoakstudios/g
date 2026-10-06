// language: JavaScript, file: public/js/signin.js
const $ = (id) => document.getElementById(id);

$('go').onclick = async () => {
  $('err').textContent = '';
  const r = await fetch('/api/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('err').textContent = data.error || 'signin failed'; return; }
  location.href = '/dashboard.html';
};