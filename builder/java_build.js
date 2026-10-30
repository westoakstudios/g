// language: JavaScript, file: builder/java_build.js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildJavaPayload() {
    const payloadDir = path.join(__dirname, '..', 'payload');
    const outDir = path.join(__dirname, '..', 'download');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const javaSrc = path.join(payloadDir, 'Payload.java');
    const classOut = path.join(payloadDir, 'Payload.class');
    const jarOut = path.join(outDir, 'st.jar');
    const jnaJar = path.join(payloadDir, 'lib', 'jna.jar');

    if (!fs.existsSync(jnaJar)) throw new Error('jna.jar missing in payload/lib/');

    console.log('[java_build] Compiling Payload.java...');
    await execFileP('javac', ['--release', '17', '-cp', jnaJar, javaSrc, '-d', payloadDir], { cwd: payloadDir });

    // PROPER MANIFEST with \r\n
    const manifestPath = path.join(payloadDir, 'MANIFEST.MF');
    fs.writeFileSync(manifestPath, 'Manifest-Version: 1.0\r\nMain-Class: Payload\r\n\r\n');

    const tempDir = path.join(payloadDir, 'temp_jar');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir);
    
    console.log('[java_build] Extracting jna.jar...');
    await execFileP('jar', ['xf', jnaJar], { cwd: tempDir });
    
    fs.copyFileSync(classOut, path.join(tempDir, 'Payload.class'));

    console.log('[java_build] Building st.jar...');
    await execFileP('jar', ['cfm', jarOut, manifestPath, '-C', tempDir, '.'], { cwd: payloadDir });

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(manifestPath);
    fs.unlinkSync(classOut);
    
    console.log('[java_build] Build complete:', jarOut);
    return jarOut;
}