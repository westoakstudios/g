// language: JavaScript, file: builder/rustbuild.js
// per-build Rust compile with the account key baked into src/embedded_key.rs.
// paths are relative to this file, so nothing depends on the server's cwd.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CARGO  = process.env.CARGO  || 'cargo';
const TARGET = process.env.RUST_TARGET || 'x86_64-pc-windows-gnu';

// rust project lives one level up from builder/, in client/
const SRC_DIR  = process.env.RUST_SRC || path.join(__dirname, '..', 'client');
const KEY_FILE = path.join(SRC_DIR, 'src', 'embedded_key.rs');

let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function writeEmbeddedKey(key) {
  const esc = String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const content =
`// auto-generated — do not edit
// written by builder/rustbuild.js before each build

pub const ACCOUNT_KEY: &str = "${esc}";
`;
  fs.writeFileSync(KEY_FILE, content, 'utf8');
}

function restorePlaceholder() {
  const content =
`// placeholder — will be overwritten by the build pipeline

pub const ACCOUNT_KEY: &str = "";
`;
  try { fs.writeFileSync(KEY_FILE, content, 'utf8'); } catch {}
}

export async function buildBoot({ key }) {
  if (!key || !String(key).trim()) throw new Error('key required');

  if (!fs.existsSync(SRC_DIR)) throw new Error(`rust source dir not found: ${SRC_DIR}`);
  if (!fs.existsSync(path.join(SRC_DIR, 'src'))) throw new Error(`src/ not found in ${SRC_DIR}`);
  if (!fs.existsSync(path.join(SRC_DIR, 'src', 'main.rs'))) throw new Error(`main.rs not found in ${SRC_DIR}/src`);

  return enqueue(async () => {
    writeEmbeddedKey(key.trim());

    try {
      const srcMain = path.join(SRC_DIR, 'src', 'main.rs');
      const now = new Date();
      try { fs.utimesSync(srcMain, now, now); } catch {}

      await execFileP(CARGO, [
        'build',
        '--release',
        '--target', TARGET,
      ], {
        cwd: SRC_DIR,
        timeout: 5 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          RUSTFLAGS: '-C target-feature=+crt-static',
          CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: 'x86_64-w64-mingw32-gcc',
        },
      });

      const outPath = path.join(SRC_DIR, 'target', TARGET, 'release', 'boot.exe');
      if (!fs.existsSync(outPath)) throw new Error('build produced no boot.exe');
      return fs.readFileSync(outPath);
    } finally {
      restorePlaceholder();
    }
  });
}