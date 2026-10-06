// language: JavaScript, file: net.js
// tcp + udp listeners. each connection is logged to console; hooks left for later.
import net from 'node:net';
import dgram from 'node:dgram';

export function startTcp({ host, port, onLine, onConn }) {
  const server = net.createServer((sock) => {
    const id = `${sock.remoteAddress}:${sock.remotePort}`;
    console.log(`[tcp] connect ${id}`);
    if (onConn) onConn(sock, id);

    sock.setEncoding('utf8');
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
    sock.on('close', () => console.log(`[tcp] close ${id}`));
  });

  server.on('error', (e) => console.error(`[tcp] server err: ${e.message}`));
  server.listen(port, host, () => console.log(`[tcp] listening ${host}:${port}`));
  return server;
}

export function startUdp({ host, port, onMsg }) {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    const id = `${rinfo.address}:${rinfo.port}`;
    const text = msg.toString('utf8').trim();
    console.log(`[udp] ${id} -> ${text.slice(0, 200)}`);
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