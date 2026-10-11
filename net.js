// language: JavaScript, file: net.js
import dgram from 'node:dgram';

const MAX_UDP_MSG = 65500;
const FRAME_TIMEOUT_MS = 100;
let udpSock = null;

const clientAddr   = new Map();
const frameStore   = new Map();
const webcamStore  = new Map();
const frameBuffers = new Map();
const monitorStore = new Map();

const framesRecv = new Map();
setInterval(() => {
  if (framesRecv.size === 0) return;
  const parts = [];
  for (const [k, n] of framesRecv) parts.push(`${k}=${n}/s`);
  console.log(`[udp] frames ${parts.join(' ')}`);
  framesRecv.clear();
}, 1000);

setInterval(() => {
  const now = Date.now();
  for (const [cid, f] of frameStore)  if (now - f.updatedAt > 30_000) frameStore.delete(cid);
  for (const [cid, f] of webcamStore) if (now - f.updatedAt > 30_000) webcamStore.delete(cid);
  for (const [k, b] of frameBuffers)  if (now - b.lastAt > FRAME_TIMEOUT_MS * 2) frameBuffers.delete(k);
}, 15_000);

// CRC32 (IEEE) — matches the Rust implementation in rdp.rs / webcam.rs
function crc32(str) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xFF];
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

function assembleFrame(buf) {
  const ordered = [];
  for (let i = 0; i < buf.total; i++) {
    const c = buf.chunks.get(i);
    if (c === undefined) return null;     // missing — reject
    ordered.push(c);
  }
  const b64 = ordered.join('');

  // CRC check if header carried one
  if (buf.crc) {
    const got = crc32(b64);
    if (got !== buf.crc) return null;     // corrupt — reject
  }

  // decode to bytes
  try { return Buffer.from(b64, 'base64'); }
  catch { return null; }
}

function storeFrame(buf) {
  const jpeg = assembleFrame(buf);
  if (!jpeg || jpeg.length === 0) return;     // incomplete or corrupt — drop

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
      // screen: cid:seq:idx:total:crc:data  (7 parts min)
      // webcam: cid:seq:idx:total:data      (6 parts min, no crc for now)
      if (parts.length < 6) return;
      const cid   = Number(parts[1]);
      const seq   = Number(parts[2]);
      const idx   = Number(parts[3]);
      const total = Number(parts[4]);
      if (!cid || !total) return;

      let crc = null;
      let dataStart;
      if (tag === 'WHFRM') {
        if (parts.length < 7) return;
        crc = parts[5];
        dataStart = 6;
      } else {
        dataStart = 5;
      }
      const data = parts.slice(dataStart).join(':');

      const key = `${kind}:${cid}`;
      let buf = frameBuffers.get(key);

      if (buf && buf.seq !== seq) {
        // stale partial — attempt final store before dropping
        if (buf.chunks.size === buf.total) storeFrame(buf);
        buf = null;
      }

      if (!buf) {
        buf = { seq, total, crc, chunks: new Map(), createdAt: Date.now(), lastAt: Date.now(), kind, cid };
        frameBuffers.set(key, buf);
      }

      buf.chunks.set(idx, data);
      buf.lastAt = Date.now();

      if (buf.chunks.size === buf.total) {
        storeFrame(buf);
        frameBuffers.delete(key);
      }
      return;
    }

    if (onMsg) onMsg(text, rinfo, udpSock);
  });

  // assembly sweep — only store COMPLETE frames; partials get dropped
  setInterval(() => {
    const now = Date.now();
    for (const [key, buf] of frameBuffers) {
      if (now - buf.lastAt > FRAME_TIMEOUT_MS) {
        // if fully assembled but slow, store it; otherwise drop
        if (buf.chunks.size === buf.total) storeFrame(buf);
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