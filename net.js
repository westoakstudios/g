// language: JavaScript, file: net.js
// udp listener: rdp frame chunks + monitor reports + live config updates from clients.

import dgram from 'node:dgram';

const MAX_UDP_MSG = 65500;
let udpSock = null;

const clientAddr = new Map();   // clientId -> { address, port }
const frameStore = new Map();   // clientId -> { jpeg, updatedAt }
const frameBuffers = new Map(); // clientId -> { seq, total, chunks, updatedAt }
const monitorStore = new Map(); // clientId -> [ {name,x,y,width,height} ]

setInterval(() => {
  const now = Date.now();
  for (const [cid, f] of frameStore) if (now - f.updatedAt > 30_000) frameStore.delete(cid);
  for (const [cid, b] of frameBuffers) if (now - b.updatedAt > 10_000) frameBuffers.delete(cid);
}, 15_000);

export function startUdp({ host, port, onMsg }) {
  udpSock = dgram.createSocket({
    type: 'udp4',
    recvBufferSize: 8 * 1024 * 1024,
    sendBufferSize: 8 * 1024 * 1024,
  });

  udpSock.on('message', (msg, rinfo) => {
    if (msg.length > MAX_UDP_MSG) return;
    const text = msg.toString('utf8');
    const firstColon = text.indexOf(':');
    if (firstColon === -1) return;
    const tag = text.slice(0, firstColon);

    if (tag === 'WHREG') {
      const [, cidStr, key] = text.split(':');
      const cid = Number(cidStr);
      if (!cid || !key) return;
      clientAddr.set(cid, { address: rinfo.address, port: rinfo.port });
      return;
    }

    if (tag === 'WHMON') {
      // WHMON:<clientId>:<json>
      const afterTag = text.slice(6);
      const colon = afterTag.indexOf(':');
      if (colon === -1) return;
      const cid = Number(afterTag.slice(0, colon));
      if (!cid) return;
      try {
        const list = JSON.parse(afterTag.slice(colon + 1));
        monitorStore.set(cid, Array.isArray(list) ? list : []);
      } catch {}
      return;
    }

    if (tag === 'WHFRM') {
      // WHFRM:<clientId>:<seq>:<idx>:<total>:<base64>
      const parts = text.split(':');
      if (parts.length < 6) return;
      const cid   = Number(parts[1]);
      const seq   = Number(parts[2]);
      const idx   = Number(parts[3]);
      const total = Number(parts[4]);
      const data  = parts.slice(5).join(':');
      if (!cid || !total) return;

      let buf = frameBuffers.get(cid);
      if (!buf || buf.seq !== seq) {
        buf = { seq, total, chunks: new Map(), updatedAt: Date.now() };
        frameBuffers.set(cid, buf);
      }
      buf.chunks.set(idx, Buffer.from(data, 'base64'));
      buf.updatedAt = Date.now();

      if (buf.chunks.size === buf.total) {
        const ordered = [];
        for (let i = 0; i < buf.total; i++) ordered.push(buf.chunks.get(i) || Buffer.alloc(0));
        frameStore.set(cid, { jpeg: Buffer.concat(ordered), updatedAt: Date.now() });
        frameBuffers.delete(cid);
      }
      return;
    }

    if (onMsg) onMsg(text, rinfo, udpSock);
  });

  udpSock.on('error', (e) => console.error(`[udp] err: ${e.message}`));
  udpSock.on('listening', () => {
    const a = udpSock.address();
    console.log(`[udp] listening ${a.address}:${a.port}`);
  });
  udpSock.bind(port, host);
  return udpSock;
}

export function sendInput(clientId, payload) {
  if (!udpSock) return false;
  const addr = clientAddr.get(clientId);
  if (!addr) return false;
  const packet = Buffer.from(`WHINP:${clientId}:${payload}`);
  if (packet.length > MAX_UDP_MSG) return false;
  udpSock.send(packet, addr.port, addr.address, () => {});
  return true;
}

export function sendCfg(clientId, payload) {
  if (!udpSock) return false;
  const addr = clientAddr.get(clientId);
  if (!addr) return false;
  const packet = Buffer.from(`WHCFG:${clientId}:${payload}`);
  if (packet.length > MAX_UDP_MSG) return false;
  udpSock.send(packet, addr.port, addr.address, () => {});
  return true;
}

export function getFrame(clientId) {
  const f = frameStore.get(clientId);
  return f ? f.jpeg : null;
}

export function getMonitors(clientId) {
  return monitorStore.get(clientId) || [];
}

export function hasClient(clientId) {
  return clientAddr.has(clientId);
}