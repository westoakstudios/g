// language: JavaScript, file: builder/zip.js
// Pads a launcher exe to a target size with zero bytes, then returns a
// single-entry ZIP containing the padded exe. Deflates in one stream with
// CRC — no giant in-memory buffer, no temp file. Target size can be huge;
// peak memory is ~1 MB chunk + compressed output (~700 KB for 700 MB of zeros).

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc, buf) {
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function dosStamp() {
  const d = new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

export async function zipPaddedExe(headBuf, innerName, targetSize) {
  if (!Buffer.isBuffer(headBuf) || headBuf.length === 0) {
    throw new Error('zipPaddedExe: head buffer empty');
  }
  if (targetSize <= headBuf.length) {
    throw new Error(`zipPaddedExe: targetSize ${targetSize} must exceed head ${headBuf.length}`);
  }
  if (targetSize > 0xFFFFFFFF) {
    throw new Error('zipPaddedExe: >4GB uncompressed requires ZIP64 — not implemented');
  }

  const padTotal = targetSize - headBuf.length;
  const CHUNK = 1024 * 1024;
  const ZERO = Buffer.alloc(CHUNK);

  // level 1 — on long zero runs the output is identical to level 9,
  // but it runs 5–10× faster. zero-runs compress to a fixed match regardless.
  const deflate = zlib.createDeflateRaw({ level: 1 });
  const deflatedChunks = [];
  deflate.on('data', (c) => deflatedChunks.push(c));

  const done = new Promise((res, rej) => {
    deflate.on('end', res);
    deflate.on('error', rej);
  });

  let crc = 0xFFFFFFFF;
  crc = crcUpdate(crc, headBuf);
  deflate.write(headBuf);

  let remaining = padTotal;
  while (remaining > 0) {
    const n = Math.min(CHUNK, remaining);
    const z = n === CHUNK ? ZERO : ZERO.subarray(0, n);
    crc = crcUpdate(crc, z);
    if (!deflate.write(z)) {
      await new Promise((r) => deflate.once('drain', r));
    }
    remaining -= n;
    // yield every ~4MB so the event loop stays responsive on 700MB runs
    if ((remaining & 0x3FFFFF) === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }

  deflate.end();
  await done;

  const deflated = Buffer.concat(deflatedChunks);
  const crcFinal = (crc ^ 0xFFFFFFFF) >>> 0;
  const uncompSize = headBuf.length + padTotal;
  const nameBuf = Buffer.from(innerName, 'utf8');
  const { time, date } = dosStamp();

  // local file header (30 bytes) + name
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);            // version needed
  lfh.writeUInt16LE(0, 6);             // general flags
  lfh.writeUInt16LE(8, 8);             // method 8 = deflate
  lfh.writeUInt16LE(time, 10);
  lfh.writeUInt16LE(date, 12);
  lfh.writeUInt32LE(crcFinal, 14);
  lfh.writeUInt32LE(deflated.length, 18);
  lfh.writeUInt32LE(uncompSize, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);            // extra len

  const cdStart = lfh.length + nameBuf.length + deflated.length;

  // central directory entry (46 bytes) + name
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);             // version made by
  cd.writeUInt16LE(20, 6);             // version needed
  cd.writeUInt16LE(0, 8);              // flags
  cd.writeUInt16LE(8, 10);             // method
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crcFinal, 16);
  cd.writeUInt32LE(deflated.length, 20);
  cd.writeUInt32LE(uncompSize, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);             // extra
  cd.writeUInt16LE(0, 32);             // comment
  cd.writeUInt16LE(0, 34);             // disk start
  cd.writeUInt16LE(0, 36);             // internal attrs
  cd.writeUInt32LE(0, 38);             // external attrs
  cd.writeUInt32LE(0, 42);             // local header offset

  const cdBuf = Buffer.concat([cd, nameBuf]);

  // end of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, nameBuf, deflated, cdBuf, eocd]);
}