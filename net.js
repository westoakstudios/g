// language: JavaScript, file: net.js
import dgram from 'node:dgram';

const MAX_UDP_MSG = 65500;
const FRAME_TIMEOUT_MS = 80;   // assemble partial frames after this long
let udpSock = null;

const clientAddr   = new Map();
const frameStore   = new Map();   // clientId -> { jpeg, updatedAt }
const webcamStore  = new Map();   // clientId -> { jpeg, updatedAt }
const frameBuffers = new Map();   // key -> { seq, total, chunks, createdAt, lastAt, kind, cid }
const monitorStore = new Map();   // clientId -> [ {name,x,y,width,height} ]

// per-second frame counters for diagnostics
const framesRecv = new Map();
setInterval(() => {
  if (framesRecv.size === 0) return;
  const parts = [];
  for (const [k, n] of framesRecv) { parts.push(`${k}=${n}/s`); }
  console.log(`[udp] frames ${parts.join(' ')}`);
  framesRecv.clear();
}, 1000);

setInterval(() => {
  const now = Date.now();
  for (const [cid, f] of frameStore)  if (now - f.updatedAt > 30_000) frameStore.delete(cid);
  for (const [cid, f] of webcamStore) if (now - f.updatedAt > 30_000) webcamStore.delete(cid);
  for (const [k, b] of frameBuffers)  if (now - b.lastAt > FRAME_TIMEOUT_MS * 2) frameBuffers.delete(k);
}, 15_000);

function assembleFrame(buf) {
  const ordered = [];
  for (let i = 0; i < buf.total; i++) ordered.push(buf.chunks.get(i) || Buffer.alloc(0));
  return Buffer.concat(ordered);
}

function storeFrame(buf) {
  const jpeg = assembleFrame(buf);
  if (jpeg.length === 0) return;
  if (buf.kind === 'screen') frameStore.set(buf.cid,  { jpeg, updatedAt: Date.now() });
  else                       webcamStore.set(buf.cid, { jpeg, updatedAt: Date.now() });

  const k = `${buf.kind}:${buf.cid}`;
  framesRecv.set(k, (framesRecv.get(k) || 0) + 1);
}

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

      // new frame (different seq) — if we had a stale one, assemble it as partial and store
      if (buf && buf.seq !== seq) {
        storeFrame(buf);
        buf = null;
      }

      if (!buf) {
        buf = { seq, total, chunks: new Map(), createdAt: Date.now(), lastAt: Date.now(), kind, cid };
        frameBuffers.set(key, buf);
      }

      buf.chunks.set(idx, Buffer.from(data, 'base64'));
      buf.lastAt = Date.now();

      if (buf.chunks.size === buf.total) {
        storeFrame(buf);
        frameBuffers.delete(key);
      }
      return;
    }

    if (onMsg) onMsg(text, rinfo, udpSock);
  });

  // assembly sweep — if a frame hasn't received a chunk in FRAME_TIMEOUT_MS, store what we have
  setInterval(() => {
    const now = Date.now();
    for (const [key, buf] of frameBuffers) {
      if (now - buf.lastAt > FRAME_TIMEOUT_MS && buf.chunks.size > buf.total * 0.4) {
        // got at least 40% of the frame — assemble partial, missing pieces become zeroes
        storeFrame(buf);
        frameBuffers.delete(key);
      }
    }
  }, 40);

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

export function getFrame(clientId)     { const f = frameStore.get(clientId);  return f ? f.jpeg : null; }
export function getWebcamFrame(cid)    { const f = webcamStore.get(cid);      return f ? f.jpeg : null; }
export function getMonitors(clientId)  { return monitorStore.get(clientId) || []; }
export function hasClient(clientId)    { return clientAddr.has(clientId); }