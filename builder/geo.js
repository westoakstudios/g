// language: JavaScript, file: builder/geo.js
// IP -> country lookup, cached per IP for 24h. uses countries.dev.
// falls back to null on failure — never blocks the client list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', 'data', 'geo-cache.json');

const TTL_MS = 24 * 60 * 60 * 1000;

let cache = {};
try {
  if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
} catch {}

let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
    } catch {}
  }, 2000);
}

function isPrivate(ip) {
  if (!ip) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('0.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

export async function countryFor(ip) {
  if (!ip || isPrivate(ip)) return null;

  const now = Date.now();
  const hit = cache[ip];
  if (hit && (now - hit.at) < TTL_MS) return hit.data;

  let data = null;
  try {
    const r = await fetch(`https://countries.dev/ip/${encodeURIComponent(ip)}?fields=name,flag,alpha2Code`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      const c = j.country || {};
      data = {
        code: c.alpha2Code || j.countryCode || '',
        name: c.name || '',
        flag: c.flag || '',
      };
    }
  } catch {}

  cache[ip] = { at: now, data };
  persistSoon();
  return data;
}

export async function countriesFor(ips) {
  const unique = [...new Set(ips.filter(Boolean))];
  await Promise.all(unique.map(countryFor));
  const out = {};
  for (const ip of unique) out[ip] = cache[ip]?.data ?? null;
  return out;
}