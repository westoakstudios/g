// language: JavaScript, file: public/js/signup.js
const $ = (id) => document.getElementById(id);

$('go').onclick = async () => {
  $('err').textContent = '';
  const body = {
    username: $('username').value.trim(),
    email: $('email').value.trim(),
    password: $('password').value,
    discordWebhook: $('webhook').value.trim()
  };
  $('go').disabled = true;
  $('go').textContent = 'verifying webhook...';
  try {
    const r = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      $('err').textContent = data.error || 'signup failed';
      $('go').disabled = false;
      $('go').textContent = 'create account';
      return;
    }
    sessionStorage.setItem('newKey', data.accountKey);
    sessionStorage.setItem('newUser', data.username);
    location.href = '/key.html';
  } catch {
    $('err').textContent = 'network error';
    $('go').disabled = false;
    $('go').textContent = 'create account';
  }
};