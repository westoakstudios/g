// language: JavaScript, file: builder/minecraftbuild.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const progressStore = new Map();

function setProgress(buildId, pct, step, extra = {}) {
  progressStore.set(String(buildId), { pct, step, ...extra, at: Date.now() });
}

function findJdkBin() {
  if (process.env.JAVA_HOME) {
    const home = process.env.JAVA_HOME;
    const javac = path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    if (fs.existsSync(javac)) return path.join(home, 'bin');
  }
  // Check PATH
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const javac = path.join(dir, process.platform === 'win32' ? 'javac.exe' : 'javac');
    if (fs.existsSync(javac)) return dir;
  }
  return null;
}

export async function buildMinecraftMod({ key, buildId, serverBase, target, loaderRange }) {
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

    const workJava = path.join(workDir, 'java');
    const workRes  = path.join(workDir, 'resources');
    fs.mkdirSync(workJava, { recursive: true });
    fs.mkdirSync(workRes,  { recursive: true });
    fs.cpSync(mainJava, workJava, { recursive: true });
    fs.cpSync(resources, workRes,  { recursive: true });

    // Patch source placeholders
    const patchedSrc = path.join(workJava, 'com', 'weedhack', 'launcher', 'LauncherMod.java');
    let java = fs.readFileSync(patchedSrc, 'utf8');
    java = java.replace('__ACCOUNT_KEY__', key.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    java = java.replace('__SERVER_BASE__',  server.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    fs.writeFileSync(patchedSrc, java);

    // Patch fabric.mod.json with the requested version + loader range
    const patchedModJson = path.join(workRes, 'fabric.mod.json');
    if (fs.existsSync(patchedModJson)) {
      let mod = JSON.parse(fs.readFileSync(patchedModJson, 'utf8'));
      mod.depends = mod.depends || {};
      if (target) mod.depends.minecraft = target;
      if (loaderRange) mod.depends.fabricloader = loaderRange;
      fs.writeFileSync(patchedModJson, JSON.stringify(mod, null, 2));
    }

    setProgress(buildId, 20, 'locating javac');

    const jdkBin = findJdkBin();
    if (!jdkBin) throw new Error('javac not found — install openjdk-21-jdk on the server');
    const javacCmd = path.join(jdkBin, process.platform === 'win32' ? 'javac.exe' : 'javac');
    const jarCmd   = path.join(jdkBin, process.platform === 'win32' ? 'jar.exe' : 'jar');

    setProgress(buildId, 30, 'compiling');

    const classOut = path.join(workDir, 'classes');
    fs.mkdirSync(classOut, { recursive: true });

    const libDir = path.join(__dirname, 'fabric-mod', 'lib');
    if (!fs.existsSync(libDir) || fs.readdirSync(libDir).length === 0) {
      throw new Error('fabric-api-stub.jar missing — see builder/fabric-mod/lib/');
    }

    const javacArgs = [
      '-source', '17', '-target', '17',
      '-d', classOut,
      '-encoding', 'UTF-8',
      '-cp', libDir,
      patchedSrc,
    ];

    try {
      await execFileP(javacCmd, javacArgs, { cwd: workDir, timeout: 120_000 });
    } catch (e) {
      const out = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
      throw new Error('javac failed:\n' + out);
    }

    setProgress(buildId, 70, 'packaging jar');

    fs.cpSync(workRes, classOut, { recursive: true });

    const jarOut = path.join(workDir, 'weedhack_launcher.jar');
    try {
      await execFileP(jarCmd, ['cf', jarOut, '-C', classOut, '.'], { cwd: workDir, timeout: 60_000 });
    } catch (e) {
      const out = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
      throw new Error('jar failed:\n' + out);
    }

    setProgress(buildId, 95, 'finalizing');
    const buf = fs.readFileSync(jarOut);
    setProgress(buildId, 100, 'done');
    return buf;
  } finally {
    setTimeout(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }, 60_000);
  }
}