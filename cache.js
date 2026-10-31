// language: JavaScript, file: cache.js
import db from './db.js';

export const userCacheById = new Map();
export const userCacheByKey = new Map();

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