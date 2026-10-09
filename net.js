// language: JavaScript, file: net.js
// raw tcp + udp listeners. per-ip connection caps, idle timeouts, clean shutdown.

import net from 'node:net';
import dgram from 'node:dgram';

const MAX_TCP_PER_IP   = 20;
const TCP_IDLE_TIMEOUT = 60_000;
const MAX_UDP_MSG      = 2048;

export function startTcp({ host, port, onConn, onLine, onClose }) {
  const perIp = new Map();
  const sockets = new Set();

  const server = net.createServer((sock) => {
    const ip = sock.remoteAddress || 'unknown';
    const id = `${ip}:${sock.remotePort}`;

    const count = perIp.get(ip) || 0;
    if (count >= MAX_TCP_PER_IP) {
      console.log(`[tcp] reject ${id} — per-ip cap reached`);
      sock.destroy();
      return;
    }
    perIp.set(ip, count + 1);
    sockets.add(sock);

    console.log(`[tcp] open ${id}`);
    sock.setEncoding('utf8');
    sock.setTimeout(TCP_IDLE_TIMEOUT, () => {
      console.log(`[tcp] idle-timeout ${id}`);
      sock.destroy();
    });

    if (onConn) onConn(sock, id);

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line && onLine) onLine(line, sock, id);
      }
      if (buf.length > 8192) buf = '';
    });

    sock.on('error', (e) => console.log(`[tcp] err ${id}: ${e.code || e.message}`));

    sock.on('close', () => {
      const c = (perIp.get(ip) || 1) - 1;
      if (c <= 0) perIp.delete(ip); else perIp.set(ip, c);
      sockets.delete(sock);
      console.log(`[tcp] close ${id}`);
      if (onClose) onClose(id);
    });
  });

  server.on('error', (e) => console.error(`[tcp] server err: ${e.message}`));
  server.listen(port, host, () => console.log(`[tcp] listening ${host}:${port}`));

  server.shutdown = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return server;
}

export function startUdp({ host, port, onMsg }) {
  const sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });

  sock.on('message', (msg, rinfo) => {
    if (msg.length > MAX_UDP_MSG) return;
    const id = `${rinfo.address}:${rinfo.port}`;
    const text = msg.toString('utf8').trim();
    console.log(`[udp] ${id} -> ${text.slice(0, 120)}`);
    if (onMsg) onMsg(text, rinfo, sock);
  });

  sock.on('error', (e) => console.error(`[udp] err: ${e.message}`));
  sock.on('listening', () => {
    const a = sock.address();
    console.log(`[udp] listening ${a.address}:${a.port}`);
  });
  sock.bind(port, host);
  return sock;
}