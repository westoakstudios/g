// language: JavaScript, file: net.js
import dgram from 'node:dgram';

const MAX_UDP_MSG   = 65500;
const FRAME_TIMEOUT = 100;
const CURSOR_TTL_MS = 8000;
const WHREG_TTL_MS  = 60000;
const PING_EVERY_MS = 5000;
const PING_TTL_MS   = 15000;
let udpSock = null;
let pingInterval = null;
let gcInterval = null;
let frameInterval = null;

const clientAddr     = new Map();   
const clientPingAddr = new Map();   
const frameStore     = new Map();
const webcamStore    = new Map();
const frameBuffers   = new Map();
const monitorStore   = new Map();
const cursorStore    = new Map();
const pingStore      = new Map();   

const framesRecv = new Map();
const cursorRecv = new Map();

function startTimers() {
  pingInterval = setInterval(() => {
    if (!udpSock) return;
    const now = Date.now();
    for (const [cid, addr] of clientPingAddr) {
      const pkt = Buffer.from(`WHPING:${cid}:${now}`);
      try { udpSock.send(pkt, addr.port, addr.address, () => {}); } catch {}
    }
  }, PING_EVERY_MS);

  gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [cid, f] of frameStore)  if (now - f.updatedAt > 30_000)   frameStore.delete(cid);
    for (const [cid, f] of webcamStore) if (now - f.updatedAt > 30_000)   webcamStore.delete(cid);
    for (const [k, b] of frameBuffers)  if (now - b.lastAt   > FRAME_TIMEOUT * 2) frameBuffers.delete(k);
    for (const [cid, c] of cursorStore) if (now - c.updatedAt > CURSOR_TTL_MS)    cursorStore.delete(cid);
    for (const [cid, p] of clientPingAddr) if (now - p.lastAt > WHREG_TTL_MS)     clientPingAddr.delete(cid);
    for (const [cid, p] of pingStore)   if (now - p.updatedAt > PING_TTL_MS)      pingStore.delete(cid);
  }, 15_000);

  frameInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, buf] of frameBuffers) {
      if (now - buf.lastAt > FRAME_TIMEOUT) {
        if (buf.chunks.size === buf.total) storeFrame(buf);
        frameBuffers.delete(key);
      }
    }
  }, 40);
}

function storeFrame(buf) {
  // For H.264, the browser needs the fragments stitched together in order.
  const parts = [];
  for (let i = 0; i < buf.total; i++) {
    const c = buf.chunks.get(i);
    if (c) parts.push(c);
  }
  
  const bytes = Buffer.concat(parts);
  if (bytes.length === 0) return;

  if (buf.kind === 'screen') frameStore.set(buf.cid,  { jpeg: bytes, updatedAt: Date.now() });
  else                       webcamStore.set(buf.cid, { jpeg: bytes, updatedAt: Date.now() });

  const k = `${buf.kind}:${buf.cid}`;
  framesRecv.set(k, (framesRecv.get(k) || 0) + 1);
}

function handleTextMessage(text, rinfo) {
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  const tag = text.slice(0, colon);

  if (tag === 'WHREG') {
    const parts = text.split(':');
    if (parts.length < 3) return null;
    const cid = Number(parts[1]);
    const key = parts[2];
    if (!cid || !key) return null;
    clientAddr.set(cid, { address: rinfo.address, port: rinfo.port });
    return 'WHREG';
  }

  if (tag === 'WHREGP') {
    const parts = text.split(':');
    if (parts.length < 3) return null;
    const cid = Number(parts[1]);
    const key = parts[2];
    if (!cid || !key) return null;
    clientPingAddr.set(cid, { address: rinfo.address, port: rinfo.port, lastAt: Date.now() });
    return 'WHREGP';
  }

  if (tag === 'WHPONG') {
    const parts = text.split(':');
    if (parts.length < 3) return null;
    const cid = Number(parts[1]);
    const sentTs = Number(parts[2]);
    if (!cid || !isFinite(sentTs)) return null;
    const rtt = Date.now() - sentTs;
    if (rtt >= 0 && rtt < 60000) {
      pingStore.set(cid, { rtt, updatedAt: Date.now() });
    }
    return 'WHPONG';
  }

  if (tag === 'WHCUR') {
    const parts = text.split(':');
    if (parts.length < 5) return null;
    const cid     = Number(parts[1]);
    const x       = Number(parts[2]);
    const y       = Number(parts[3]);
    const visible = parts[4] === '1';

    if (!cid) return null;
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;

    cursorStore.set(cid, { x, y, visible, updatedAt: Date.now() });
    cursorRecv.set(cid, (cursorRecv.get(cid) || 0) + 1);
    return 'WHCUR';
  }

  if (tag === 'WHMON') {
    const rest = text.slice(6);
    const c = rest.indexOf(':');
    if (c === -1) return null;
    const cid = Number(rest.slice(0, c));
    if (!cid) return null;
    try {
      const list = JSON.parse(rest.slice(c + 1));
      monitorStore.set(cid, Array.isArray(list) ? list : []);
    } catch {}
    return 'WHMON';
  }

  return null;
}

export function startUdp({ host, port, onMsg }) {
  udpSock = dgram.createSocket({
    type: 'udp4',
    recvBufferSize: 8 * 1024 * 1024,
    sendBufferSize: 8 * 1024 * 1024,
  });

  udpSock.on('message', (msg, rinfo) => {
    if (msg.length > MAX_UDP_MSG) return;

    const nl = msg.indexOf(0x0A);

    if (nl === -1) {
      const text = msg.toString('utf8');
      const handled = handleTextMessage(text, rinfo);
      if (!handled && onMsg) onMsg(text, rinfo, udpSock);
      return;
    }

    const header = msg.slice(0, nl).toString('utf8');
    const body   = msg.slice(nl + 1);
    const parts  = header.split(':');
    const tag    = parts[0];

    if (tag === 'WHFRM' || tag === 'WHCAM') {
      const kind = tag === 'WHFRM' ? 'screen' : 'webcam';
      if (parts.length < 6) return;

      const cid   = Number(parts[1]);
      const seq   = Number(parts[2]);
      const idx   = Number(parts[3]);
      const total = Number(parts[4]);
      if (!cid || !total) return;

      const key = `${kind}:${cid}`;
      let buf = frameBuffers.get(key);

      // Reset buffer if sequence changes
      if (buf && buf.seq !== seq) {
        if (buf.chunks.size === buf.total) storeFrame(buf);
        buf = null;
      }

      if (!buf) {
        buf = { seq, total, chunks: new Map(), lastAt: Date.now(), kind, cid };
        frameBuffers.set(key, buf);
      }

      buf.chunks.set(idx, body);
      buf.lastAt = Date.now();

      // If we have all chunks, assemble and store
      if (buf.chunks.size === buf.total) {
        storeFrame(buf);
        frameBuffers.delete(key);
      }
      return;
    }
  });

  startTimers();

  udpSock.on('error', (e) => console.error(`[udp] err: ${e.message}`));
  udpSock.on('listening', () => {
    const a = udpSock.address();
    console.log(`[udp] listening ${a.address}:${a.port}`);
  });
  udpSock.bind(port, host);
  return udpSock;
}

export function closeUdp() {
  if (pingInterval) clearInterval(pingInterval);
  if (gcInterval) clearInterval(gcInterval);
  if (frameInterval) clearInterval(frameInterval);
  
  if (udpSock) {
    try { udpSock.close(); } catch {}
    udpSock = null;
  }
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

export function getCursor(clientId) {
  const c = cursorStore.get(clientId);
  if (!c) return null;
  if (Date.now() - c.updatedAt > CURSOR_TTL_MS) return null;
  return { x: c.x, y: c.y, visible: c.visible };
}

export function getPing(clientId) {
  const p = pingStore.get(clientId);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PING_TTL_MS) return null;
  return Math.round(p.rtt);
}