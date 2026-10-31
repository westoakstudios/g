// language: JavaScript, file: cache.js
import { db } from './local_db.js';

export const userCacheById = new Map();
export const userCacheByKey = new Map();

const memCache = new Map();

export function getCache(key) {
  const item = memCache.get(key);
  if (item && item.expiry > Date.now()) return item.value;
  if (item) memCache.delete(key);
  return null;
}

export function setCache(key, value, ttlMs) {
  memCache.set(key, { value, expiry: Date.now() + ttlMs });
}

export function clearCache(prefix) {
  for (const key of memCache.keys()) {
    if (key.startsWith(prefix)) memCache.delete(key);
  }
}

export async function getCachedUser(uidOrKey) {
  if (typeof uidOrKey === 'number' || !isNaN(uidOrKey)) {
    const id = Number(uidOrKey);
    if (userCacheById.has(id)) return userCacheById.get(id);
    
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (rows.length) {
      const u = rows[0];
      userCacheById.set(u.id, u);
      userCacheByKey.set(u.account_key, u);
      return u;
    }
  } else {
    if (userCacheByKey.has(uidOrKey)) return userCacheByKey.get(uidOrKey);
    
    const [rows] = await db.query('SELECT * FROM users WHERE account_key = ?', [uidOrKey]);
    if (rows.length) {
      const u = rows[0];
      userCacheById.set(u.id, u);
      userCacheByKey.set(u.account_key, u);
      return u;
    }
  }
  return null;
}

export function invalidateUser(uid) {
  const u = userCacheById.get(uid);
  if (u) userCacheByKey.delete(u.account_key);
  userCacheById.delete(uid);
}