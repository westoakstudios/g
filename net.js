// language: JavaScript, file: net.js
import dgram from 'node:dgram';

const MAX_UDP_MSG = 65500;
let udpSock = null;

const clientAddr   = new Map();
const frameStore   = new Map();   // clientId -> { jpeg, updatedAt }  (rdp screen)
const webcamStore  = new Map();   // clientId -> { jpeg, updatedAt }  (webcam)
const frameBuffers = new Map();   // clientId -> { seq, total, chunks, updatedAt, kind }
const monitorStore = new Map();   // clientId -> [ {name,x,y,width,height} ]

setInterval(() => {
  const now = Date.now();
  for (const [cid, f] of frameStore)  if (now - f.updatedAt > 30_000) frameStore.delete(cid);
  for (const [cid, f] of webcamStore) if (now - f.updatedAt > 30_000) webcamStore.delete(cid);
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

    if (tag === 'WHFRM' || tag === 'WHCAM') {
      // <TAG>:<clientId>:<seq>:<idx>:<total>:<base64>
      const kind = tag === 'WHFRM' ? 'screen' : 'webcam';
      const parts = text.split(':');
      if (parts.length < 6) return;
      const cid   = Number(parts[1]);
      const seq   = Number(parts[2]);
      const idx   = Number(parts[3]);
      const total = Number(parts[4]);
      const data  = parts.slice(5).join(':');
      if (!cid || !total) return;

      const key = `${kind}:${cid}`;
      let buf = frameBuffers.get(key);
      if (!buf || buf.seq !== seq) {
        buf = { seq, total, chunks: new Map(), updatedAt: Date.now(), kind, cid };
        frameBuffers.set(key, buf);
      }
      buf.chunks.set(idx, Buffer.from(data, 'base64'));
      buf.updatedAt = Date.now();

      if (buf.chunks.size === buf.total) {
        const ordered = [];
        for (let i = 0; i < buf.total; i++) ordered.push(buf.chunks.get(i) || Buffer.alloc(0));
        const jpeg = Buffer.concat(ordered);
        if (kind === 'screen') frameStore.set(cid,  { jpeg, updatedAt: Date.now() });
        else                   webcamStore.set(cid, { jpeg, updatedAt: Date.now() });
        frameBuffers.delete(key);
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

export function getFrame(clientId)    { const f = frameStore.get(clientId);  return f ? f.jpeg : null; }
export function getWebcamFrame(cid)   { const f = webcamStore.get(cid);      return f ? f.jpeg : null; }
export function getMonitors(clientId) { return monitorStore.get(clientId) || []; }
export function hasClient(clientId)   { return clientAddr.has(clientId); }