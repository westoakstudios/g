// language: JavaScript, file: public/js/key.js
const key = sessionStorage.getItem('newKey') || '—';
document.getElementById('key').textContent = key;
document.getElementById('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(key); document.getElementById('err').textContent = 'copied'; }
  catch { document.getElementById('err').textContent = 'copy failed — select manually'; }
};
document.getElementById('next').onclick = () => location.href = '/dashboard.html';