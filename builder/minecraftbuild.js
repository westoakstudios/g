// language: JavaScript, file: builder/minecraftbuild.js
// Builds a Fabric mod jar with the user's account key + server base baked in,
// then returns it as a Buffer. Requires javac + jar on PATH (or JAVA_HOME).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Writable progress store — server.js reads this map to report build status.
export const progressStore = new Map();

function setProgress(buildId, pct, step) {
  progressStore.set(String(buildId), { pct, step, at: Date.now() });
}

export async function buildMinecraftMod({ key, buildId, serverBase }) {
  const server = serverBase || process.env.SERVER_BASE || 'http://127.0.0.1';
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-mc-'));

  try {
    setProgress(buildId, 5, 'staging sources');

    const srcRoot    = path.join(__dirname, 'fabric-mod', 'src');
    const mainJava   = path.join(srcRoot, 'main', 'java');
    const resources  = path.join(srcRoot, 'main', 'resources');
    const modJson    = path.join(resources, 'fabric.mod.json');
    const srcJava    = path.join(mainJava, 'com', 'weedhack', 'launcher', 'LauncherMod.java');

    if (!fs.existsSync(srcJava)) throw new Error('fabric mod source missing');
    if (!fs.existsSync(modJson)) throw new Error('fabric.mod.json missing');

    // Copy the mod source into the work dir and patch the placeholders.
    const workJava = path.join(workDir, 'java');
    const workRes  = path.join(workDir, 'resources');
    fs.mkdirSync(workJava, { recursive: true });
    fs.mkdirSync(workRes,  { recursive: true });
    fs.cpSync(mainJava, workJava, { recursive: true });
    fs.cpSync(resources, workRes, { recursive: true });

    const patchedSrc = path.join(workJava, 'com', 'weedhack', 'launcher', 'LauncherMod.java');
    let java = fs.readFileSync(patchedSrc, 'utf8');
    java = java.replace('__ACCOUNT_KEY__', key.replace(/"/g, '\\"'));
    java = java.replace('__SERVER_BASE__',  server.replace(/"/g, '\\"'));
    fs.writeFileSync(patchedSrc, java);

    // Also patch the mod id so each user gets a unique jar? No — same mod id
    // means Minecraft dedupes; keep it stable.

    setProgress(buildId, 20, 'locating javac');

    // Locate a JDK. Fall back to PATH.
    const javaHome = process.env.JAVA_HOME || '';
    const javacCmd = javaHome
      ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
      : 'javac';
    const jarCmd   = javaHome
      ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
      : 'jar';

    if (!fs.existsSync(javacCmd) && javacCmd !== 'javac')
      throw new Error(`javac not found at ${javacCmd} — set JAVA_HOME`);

    setProgress(buildId, 30, 'compiling');

    const classOut = path.join(workDir, 'classes');
    fs.mkdirSync(classOut, { recursive: true });

    // Compile against a minimal Fabric API surface — we only need the
    // ClientModInitializer / ClientTickEvents / MinecraftClient types. If the
    // build host does not have the Fabric API jar, javac will fail. The
    // recommended way is to ship a `fabric-api-stub.jar` next to this file,
    // or symlink the real fabric-api jar into `builder/fabric-mod/lib/`.
    //
    // The stub only needs class *signatures*, not implementations — javac
    // resolves references at compile time, so a stub jar is enough to produce
    // a runnable mod that links against the real Fabric API on the client.
    const libDir = path.join(__dirname, 'fabric-mod', 'lib');
    const cp = fs.existsSync(libDir) ? libDir : '';

    const javacArgs = [
      '-source', '17', '-target', '17',
      '-d', classOut,
      '-encoding', 'UTF-8',
    ];
    if (cp) javacArgs.push('-cp', cp);
    javacArgs.push(patchedSrc);

    await execFileP(javacCmd, javacArgs, { cwd: workDir, timeout: 120_000 });

    setProgress(buildId, 70, 'packaging jar');

    // Copy resources into class dir, then jar it up.
    fs.cpSync(workRes, classOut, { recursive: true });

    const jarOut = path.join(workDir, 'weedhack_launcher.jar');
    await execFileP(jarCmd, ['cf', jarOut, '-C', classOut, '.'], {
      cwd: workDir, timeout: 60_000,
    });

    setProgress(buildId, 95, 'finalizing');
    const buf = fs.readFileSync(jarOut);
    setProgress(buildId, 100, 'done');
    return buf;
  } finally {
    // Don't delete instantly — server.js may still be reading progress.
    setTimeout(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }, 60_000);
  }
}