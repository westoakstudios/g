// language: JavaScript, file: public/js/key.js
const akey = sessionStorage.getItem('newKey')   || '—';
const ltok = sessionStorage.getItem('newLogin') || '—';
document.getElementById('akey').textContent = akey;
document.getElementById('ltok').textContent = ltok;

document.getElementById('copy').addEventListener('click', async () => {
  const text = `account key: ${akey}\nlogin token: ${ltok}`;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('err').textContent = 'copied';
  } catch {
    document.getElementById('err').textContent = 'copy failed — select manually';
  }
});

document.getElementById('next').addEventListener('click', () => {
  location.href = '/dashboard.html';
});