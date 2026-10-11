// language: Rust, file: src/discovery.rs
// fetch the public t.me/s/<bot> page over TLS, follow redirects, extract first public IPv4.

use native_tls::TlsConnector;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

const STEP_TIMEOUT: Duration = Duration::from_secs(10);
const OVERALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: u32 = 5;
const MAX_BODY: usize = 4 * 1024 * 1024;

pub const TELEGRAM_URL: &str = "https://t.me/s/AYuniteBot";

pub fn fetch_ip(url: &str) -> Result<String, String> {
    let url = url.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(inner(&url)); });
    match rx.recv_timeout(OVERALL_TIMEOUT) {
        Ok(r) => r,
        Err(_) => Err("discovery timeout".into()),
    }
}

fn inner(start_url: &str) -> Result<String, String> {
    let mut url = start_url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        match request(&url)? {
            Response::Ok(body) => {
                return find_ipv4(&body).ok_or_else(|| "no IPv4 on page".into());
            }
            Response::Redirect(loc) => {
                url = resolve_url(&url, &loc);
            }
        }
    }
    Err("too many redirects".into())
}

enum Response { Ok(String), Redirect(String) }

fn request(url: &str) -> Result<Response, String> {
    let rest = url.strip_prefix("https://").ok_or("not https")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match hostport.find(':') {
        Some(i) => {
            let p = hostport[i + 1..].parse::<u16>().map_err(|_| "bad port")?;
            (&hostport[..i], p)
        }
        None => (hostport, 443u16),
    };

    let addr_str = format!("{host}:{port}");
    let (dtx, drx) = mpsc::channel();
    std::thread::spawn({
        let a = addr_str.clone();
        move || { let _ = dtx.send(a.to_socket_addrs().map(|it| it.collect::<Vec<_>>())); }
    });
    let addrs = match drx.recv_timeout(STEP_TIMEOUT) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(format!("dns: {e}")),
        Err(_) => return Err("dns timeout".into()),
    };
    let ip = addrs.into_iter().next().ok_or("dns: none")?;

    let tcp = TcpStream::connect_timeout(&ip, STEP_TIMEOUT).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(STEP_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(STEP_TIMEOUT)).ok();
    tcp.set_nodelay(true).ok();

    let tls = TlsConnector::builder().build().map_err(|e| e.to_string())?;
    let mut stream = tls.connect(host, tcp).map_err(|e| e.to_string())?;

    let req = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n\
         Accept: text/html,*/*\r\n\
         Accept-Encoding: identity\r\n\
         Connection: close\r\n\
         \r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().ok();

    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_BODY { break; }
            }
            Err(e) if matches!(e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(e) => return Err(e.to_string()),
        }
    }

    parse(&buf)
}

fn parse(raw: &[u8]) -> Result<Response, String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no separator")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body_bytes = &raw[split + 4..];

    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    let code: u16 = status_line.split_whitespace().nth(1)
        .and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some(i) = line.find(':') {
            headers.push((
                line[..i].trim().to_ascii_lowercase(),
                line[i + 1..].trim().to_string(),
            ));
        }
    }
    let hdr = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());

    if (300..400).contains(&code) {
        let loc = hdr("location").ok_or("30x without Location")?;
        return Ok(Response::Redirect(loc.to_string()));
    }
    if !(200..300).contains(&code) {
        return Err(format!("http {code}"));
    }

    let body = if hdr("transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        decode_chunked(body_bytes)?
    } else {
        body_bytes.to_vec()
    };

    Ok(Response::Ok(String::from_utf8_lossy(&body).to_string()))
}

fn decode_chunked(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let mut j = i;
        while j + 1 < data.len() && !(data[j] == b'\r' && data[j + 1] == b'\n') { j += 1; }
        if j + 1 >= data.len() { break; }
        let len_line = std::str::from_utf8(&data[i..j]).unwrap_or("").trim();
        let len_hex = len_line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(len_hex, 16).map_err(|_| "bad chunk")?;
        i = j + 2;
        if size == 0 { break; }
        let end = (i + size as usize).min(data.len());
        out.extend_from_slice(&data[i..end]);
        i = end;
        if i + 1 < data.len() && data[i] == b'\r' && data[i + 1] == b'\n' { i += 2; }
    }
    Ok(out)
}

fn resolve_url(base: &str, loc: &str) -> String {
    if loc.starts_with("http://") || loc.starts_with("https://") {
        return loc.to_string();
    }
    let rest = base.strip_prefix("https://").unwrap_or(base);
    let host = match rest.find('/') { Some(i) => &rest[..i], None => rest };
    if loc.starts_with('/') {
        format!("https://{host}{loc}")
    } else {
        format!("https://{host}/{loc}")
    }
}

fn find_ipv4(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') { i += 1; }
            let token = &text[start..i];
            if valid_ipv4(token) && !is_private(token) { return Some(token.to_string()); }
        } else {
            i += 1;
        }
    }
    None
}

fn valid_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.parse::<u8>().is_ok())
}

fn is_private(s: &str) -> bool {
    s.starts_with("10.") || s.starts_with("127.") || s.starts_with("0.")
        || s.starts_with("192.168.") || s.starts_with("169.254.")
        || s.starts_with("172.16.") || s.starts_with("172.17.")
        || s.starts_with("172.18.") || s.starts_with("172.19.")
        || s.starts_with("172.2") || s.starts_with("172.30.")
        || s.starts_with("172.31.")
}