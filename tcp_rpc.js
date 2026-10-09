// language: JavaScript, file: tcp_rpc.js
// one JSON line in → one JSON line out. handles register/pull/result/upload.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { UPLOAD_DIR } from './db.js';

const sql = (strings, ...vals) => {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
};

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024);

function authKey(key) {
  if (!key) return null;
  return db.prepare(sql`SELECT id, username FROM users WHERE account_key = ?`).get(key);
}

export function handleTcpLine(line, sock) {
  const reply = (obj) => {
    try { sock.write(JSON.stringify(obj) + '\n'); } catch {}
    sock.end();
  };

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return reply({ error: 'bad json' });
  }

  const cmd = msg.cmd;
  const user = authKey(msg.key);
  if (!user) return reply({ error: 'invalid key' });
  const uid = user.id;

  switch (cmd) {
    case 'register': {
      const hostname = String(msg.hostname || 'unknown').slice(0, 64);
      const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
      const existing = db.prepare(sql`SELECT id FROM clients WHERE user_id = ? AND hostname = ?`).get(uid, hostname);
      if (existing) {
        db.prepare(sql`UPDATE clients SET ip = ?, last_seen = ? WHERE id = ?`).run(ip, Date.now(), existing.id);
        return reply({ ok: true, clientId: Number(existing.id) });
      }
      const info = db.prepare(sql`
        INSERT INTO clients (user_id, key, hostname, ip, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `).run(uid, msg.key, hostname, ip, Date.now());
      return reply({ ok: true, clientId: Number(info.lastInsertRowid) });
    }

    case 'pull': {
      const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
      const clientId = Number(msg.clientId || 0);
      let client = null;
      if (clientId) {
        client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, uid);
      }
      if (!client) {
        client = db.prepare(sql`
          SELECT id FROM clients WHERE user_id = ? AND ip = ?
          ORDER BY last_seen DESC LIMIT 1
        `).get(uid, ip);
      }
      if (client) {
        db.prepare(sql`UPDATE clients SET last_seen = ?, ip = ? WHERE id = ?`).run(Date.now(), ip, client.id);
      }
      const c = db.prepare(sql`
        SELECT id, shell, line FROM commands
        WHERE user_id = ? AND status = 'pending'
        ORDER BY created_at ASC LIMIT 1
      `).get(uid);
      if (!c) return reply({ id: null, clientId: client ? Number(client.id) : null });
      db.prepare(sql`UPDATE commands SET status = 'sent' WHERE id = ?`).run(c.id);
      return reply({
        id: Number(c.id),
        shell: c.shell,
        line: c.line,
        clientId: client ? Number(client.id) : null,
      });
    }

    case 'result': {
      if (!msg.id) return reply({ error: 'missing id' });
      const info = db.prepare(sql`
        UPDATE commands SET output = ?, status = 'done'
        WHERE id = ? AND user_id = ?
      `).run(String(msg.output || '').slice(0, 65536), msg.id, uid);
      if (info.changes === 0) return reply({ error: 'not found' });
      return reply({ ok: true });
    }

    case 'upload': {
      const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
      const clientId = Number(msg.clientId || 0);
      const name = String(msg.name || 'upload.zip').slice(0, 128).replace(/[^\w.\-]/g, '_');
      if (typeof msg.data !== 'string' || !msg.data) return reply({ error: 'no data' });
      let bytes;
      try {
        bytes = Buffer.from(msg.data, 'base64');
      } catch {
        return reply({ error: 'bad base64' });
      }
      if (bytes.length === 0) return reply({ error: 'empty' });
      if (bytes.length > MAX_UPLOAD) return reply({ error: 'too large' });
      if (!(bytes[0] === 0x50 && bytes[1] === 0x4B)) return reply({ error: 'not a zip' });

      let client = null;
      if (clientId) {
        client = db.prepare(sql`SELECT id FROM clients WHERE id = ? AND user_id = ?`).get(clientId, uid);
      }
      if (!client) {
        client = db.prepare(sql`
          SELECT id FROM clients WHERE user_id = ? AND ip = ?
          ORDER BY last_seen DESC LIMIT 1
        `).get(uid, ip);
      }
      if (!client) return reply({ error: 'client not registered' });

      const storedName = `${crypto.randomUUID()}.zip`;
      const dest = path.join(UPLOAD_DIR, storedName);
      try { fs.writeFileSync(dest, bytes, { mode: 0o600 }); }
      catch (e) { return reply({ error: 'write failed' }); }

      const info = db.prepare(sql`
        INSERT INTO uploads (user_id, client_id, filename, stored_name, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uid, client.id, name, storedName, bytes.length, Date.now());
      return reply({ ok: true, uploadId: Number(info.lastInsertRowid), filename: name, size: bytes.length });
    }

    default:
      return reply({ error: `unknown cmd: ${cmd}` });
  }
}