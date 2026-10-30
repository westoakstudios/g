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

    // Compile
    await execFileP('javac', ['-cp', jnaJar, javaSrc, '-d', payloadDir], { cwd: payloadDir });

    // Create Manifest
    const manifestPath = path.join(payloadDir, 'MANIFEST.MF');
    fs.writeFileSync(manifestPath, 'Manifest-Version: 1.0\nMain-Class: Payload\n');

    // Package into Jar including JNA
    // 1. Unpack jna.jar into a temp dir
    const tempDir = path.join(payloadDir, 'temp_jar');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir);
    
    await execFileP('jar', ['xf', jnaJar], { cwd: tempDir });
    fs.copyFileSync(classOut, path.join(tempDir, 'Payload.class'));

    // 2. Build final jar
    await execFileP('jar', ['cfm', jarOut, manifestPath, '-C', tempDir, '.'], { cwd: payloadDir });

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(manifestPath);
    fs.unlinkSync(classOut);
    
    return jarOut;
}