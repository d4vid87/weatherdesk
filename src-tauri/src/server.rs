// The LAN server: the dashboard, the hub's broadcasts, the archive and the settings blob, for
// every other screen in the house.
//
// v2 ran one thread over `incoming_requests()`, which meant a slow route stalled the page's own
// assets and ruled out anything long-lived. v3 runs a small pool and hands streams (SSE, CSV,
// database backups) to threads of their own, so nothing blocks anything else.
//
// Trust model unchanged and deliberate: anything on the LAN can read and write `/config`, and
// that includes the Tempest token. `/public` and `/config-public` are the redacted view for
// screens you don't trust that far.

use crate::store;
use include_dir::{include_dir, Dir};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Request, Response, ResponseBox, Server};

/// The dashboard is embedded rather than resolved through Tauri: the headless build has no
/// Tauri to ask, and one source beats two that can disagree.
static SITE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../site");

pub const DEFAULT_PORT: u16 = 8088;
const HUB_PORT: u16 = 50222;
/// Streams cost a thread each. Eight is more screens than any house has; the ninth is told so.
const MAX_SSE: usize = 8;
const WORKERS: usize = 4;

pub struct State {
    /// Latest broadcast per packet type, as received. Raw JSON: the page already knows the
    /// Tempest tuple layouts, so re-modelling them in Rust would be two copies to keep in sync.
    pub packets: Mutex<HashMap<String, String>>,
    pub cfg_path: PathBuf,
    pub data_dir: PathBuf,
    /// (tz, row count, newest ts, body) — see `/history/daily`.
    daily: Mutex<Option<(i64, i64, i64, String)>>,
    sse: Mutex<Vec<SyncSender<String>>>,
    sse_n: AtomicUsize,
    pub backfill: Mutex<&'static str>,
}

impl State {
    pub fn new(data_dir: PathBuf, cfg_path: PathBuf) -> Arc<State> {
        Arc::new(State {
            packets: Mutex::new(HashMap::new()),
            cfg_path,
            data_dir,
            daily: Mutex::new(None),
            sse: Mutex::new(Vec::new()),
            sse_n: AtomicUsize::new(0),
            backfill: Mutex::new("off"),
        })
    }

    /// Fan one event out to every listening screen. A client that can't keep up with 64 queued
    /// events is gone or wedged — drop it rather than grow a queue nobody reads.
    pub fn broadcast(&self, event: &str, data: &str) {
        let frame = format!("event: {event}\ndata: {data}\n\n");
        if let Ok(mut subs) = self.sse.lock() {
            subs.retain(|tx| tx.try_send(frame.clone()).is_ok());
        }
    }

    pub fn db(&self) -> Option<rusqlite::Connection> {
        store::open(&store::db_path(&self.data_dir)).ok()
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn epoch() -> u64 {
    now()
}

/// Day of month, hour and minute in UTC, which is the only calendar arithmetic left outside
/// SQLite — CWOP timestamps its reports this way. Howard Hinnant's civil-from-days, because std
/// has no calendar and a date crate for six lines would be a dependency to keep updated forever.
pub fn utc_dhm(epoch: i64) -> (u32, u32, u32) {
    let days = epoch.div_euclid(86_400);
    let secs = epoch.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    (d, (secs / 3600) as u32, ((secs % 3600) / 60) as u32)
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn json(body: String) -> ResponseBox {
    Response::from_string(body)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .boxed()
}

// --- Config ---

/// Strip every credential out of the settings blob for the public dashboard.
///
/// Deny by key name, and the keys are listed here rather than derived: a future setting that
/// holds a secret has to be added to this list, and a test below fails loudly if the token ever
/// survives. Anything not recognised is kept — the public page still needs the station's
/// coordinates and units to render.
///
/// `cwopId` is deliberately absent: a CWOP callsign is public by design (the network's passcode
/// for receive-only stations is the constant -1), and redacting it would only break the badge.
const SECRET_KEYS: [&str; 6] = ["token", "mqttUser", "mqttPass", "haToken", "ntfyTopic", "webhookUrl"];

fn redact(config_json: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return "{}".into();
    };
    if let Some(s) = v.get_mut("settings").and_then(|s| s.as_object_mut()) {
        for k in SECRET_KEYS {
            if s.contains_key(k) {
                s.insert(k.into(), serde_json::Value::String(String::new()));
            }
        }
    }
    v.to_string()
}

fn read_config(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|_| "{}".into())
}

/// Merge a settings write.
///
/// A v3 client sends only what it changed, tagged with the `_rev` it last saw, and gets the
/// merged blob back. A v2 client sends the whole blob with no `_rev` and gets its 204 — that
/// path has to keep working unchanged, because those clients are already installed and their
/// window into this house is this one route.
fn write_config(path: &Path, body: &str) -> Option<(u16, String, u64)> {
    let incoming = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let obj = incoming.as_object()?;
    let mut current: serde_json::Value = serde_json::from_str(&read_config(path)).unwrap_or_else(|_| serde_json::json!({}));
    if !current.is_object() {
        current = serde_json::json!({});
    }
    let delta = obj.contains_key("_rev");
    let rev = current.get("_rev").and_then(|r| r.as_u64()).unwrap_or(0) + 1;
    let merged = if delta {
        let target = current.as_object_mut().unwrap();
        for (k, v) in obj {
            if k != "_rev" {
                target.insert(k.clone(), v.clone());
            }
        }
        current
    } else {
        incoming.clone()
    };
    let mut merged = merged;
    merged.as_object_mut()?.insert("_rev".into(), rev.into());
    let text = merged.to_string();
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).ok()?;
    }
    std::fs::write(path, &text).ok()?;
    Some(if delta { (200, text, rev) } else { (204, String::new(), rev) })
}

// --- Server-sent events ---

/// One screen's event stream.
///
/// The socket is written by hand rather than through a `Response`: tiny_http chunk-encodes a
/// body of unknown length through a buffer it only flushes when the response ends, which for a
/// stream that never ends means nothing is ever delivered. Identity encoding terminated by the
/// close is what EventSource wants anyway.
///
/// The 15-second comment is the keepalive: without a write, a peer that vanished behind a NAT
/// sits here holding a thread and a slot until the kernel gives up on the socket.
fn sse(state: &Arc<State>, req: Request) {
    if state.sse_n.fetch_add(1, Ordering::Relaxed) >= MAX_SSE {
        state.sse_n.fetch_sub(1, Ordering::Relaxed);
        let _ = req.respond(Response::empty(503));
        return;
    }
    let (tx, rx) = sync_channel::<String>(64);
    if let Ok(mut subs) = state.sse.lock() {
        subs.push(tx);
    }
    let state = state.clone();
    // Its own thread for as long as the screen is open — a worker parked here would be a
    // quarter of the pool gone until someone closed a tab.
    std::thread::spawn(move || {
        let mut w = req.into_writer();
        let ok = w
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\
                  Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            )
            .and_then(|_| w.flush())
            .is_ok();
        if ok {
            loop {
                let frame = match rx.recv_timeout(Duration::from_secs(15)) {
                    Ok(f) => f,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => ": ping\n\n".into(),
                    Err(_) => break,
                };
                if w.write_all(frame.as_bytes()).and_then(|_| w.flush()).is_err() {
                    break;
                }
            }
        }
        state.sse_n.fetch_sub(1, Ordering::Relaxed);
    });
}

// --- Routes ---

fn query(url: &str, key: &str) -> Option<String> {
    url.split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .map(String::from)
}

fn asset(path: &str) -> Option<(Vec<u8>, &'static str)> {
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // The site is baked in at compile time, so editing a file would otherwise mean rebuilding
    // the binary to see it. `WD_SITE_DIR` serves from disk instead — development only; nothing
    // sets it in a release.
    let live = std::env::var("WD_SITE_DIR").ok().map(|d| Path::new(&d).join(rel));
    let bytes = match live {
        Some(p) if p.is_file() => std::fs::read(p).ok()?,
        _ => SITE.get_file(rel)?.contents().to_vec(),
    };
    let mime = match Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    Some((bytes, mime))
}

fn handle(state: &Arc<State>, mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    if path == "/events" {
        sse(state, req);
        return;
    }

    let res: ResponseBox = match path.as_str() {
        "/udp" => {
            let map = state.packets.lock().map(|m| m.clone()).unwrap_or_default();
            let body: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("{}:{}", serde_json::Value::from(k.as_str()), v))
                .collect();
            json(format!("{{{}}}", body.join(",")))
        }
        // A read-only dashboard for anyone on the network — the family tablet, a guest phone, a
        // reverse proxy to the outside world. Same config with every secret taken out of it, and
        // a flag the page uses to hide the settings drawer.
        "/config-public" => json(redact(&read_config(&state.cfg_path))),
        "/public" => {
            let page = asset("/index.html")
                .map(|(b, _)| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
                .replace("<head>", "<head><script>window.__WD_PUBLIC=1</script>");
            Response::from_string(page).with_header(header("Content-Type", "text/html")).boxed()
        }
        // The National Hurricane Center serves its storm list without CORS headers, so no page
        // can read it. One fixed URL, fetched here and handed on — not a general proxy.
        "/proxy/nhc" => {
            let body = ureq::get("https://www.nhc.noaa.gov/CurrentStorms.json")
                .timeout(Duration::from_secs(20))
                .call()
                .ok()
                .and_then(|r| r.into_string().ok());
            match body {
                Some(body) => json(body),
                None => Response::empty(502).with_header(header("Access-Control-Allow-Origin", "*")).boxed(),
            }
        }
        "/history/daily" => {
            let tz = query(&url, "tz").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let (count, max) = store::stamp(&conn);
            let mut cache = state.daily.lock().unwrap();
            if cache.as_ref().map(|(t, c, m, _)| (*t, *c, *m)) != Some((tz, count, max)) {
                *cache = Some((tz, count, max, store::daily_json(&conn, tz)));
            }
            json(cache.as_ref().unwrap().3.clone())
        }
        "/history/coverage" => {
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let phase = *state.backfill.lock().unwrap();
            json(store::coverage_json(&conn, phase))
        }
        "/history.csv" => {
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let res = Response::new(
                tiny_http::StatusCode(200),
                vec![
                    header("Content-Type", "text/csv"),
                    header("Content-Disposition", "attachment; filename=weatherdesk-history.csv"),
                    header("Access-Control-Allow-Origin", "*"),
                ],
                store::CsvPager::new(conn),
                None,
                None,
            );
            // Years of minutes at a few hundred bytes a row: not a worker's job.
            std::thread::spawn(move || {
                let _ = req.respond(res);
            });
            return;
        }
        "/backup.db" => {
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let dest = state.data_dir.join("backup-tmp.db");
            if store::backup_to(&conn, &dest).is_err() {
                return drop(req.respond(Response::empty(500)));
            }
            let Ok(file) = std::fs::File::open(&dest) else {
                return drop(req.respond(Response::empty(500)));
            };
            let len = file.metadata().map(|m| m.len() as usize).ok();
            let res = Response::new(
                tiny_http::StatusCode(200),
                vec![
                    header("Content-Type", "application/octet-stream"),
                    header("Content-Disposition", "attachment; filename=weatherdesk.db"),
                    header("Access-Control-Allow-Origin", "*"),
                ],
                file,
                len,
                None,
            );
            std::thread::spawn(move || {
                let _ = req.respond(res);
                let _ = std::fs::remove_file(&dest);
            });
            return;
        }
        "/config" => match *req.method() {
            tiny_http::Method::Get => json(read_config(&state.cfg_path)),
            tiny_http::Method::Put => {
                let mut body = String::new();
                let read = req.as_reader().take(256 * 1024).read_to_string(&mut body).is_ok();
                match read.then(|| write_config(&state.cfg_path, &body)).flatten() {
                    Some((200, merged, rev)) => {
                        state.broadcast("config", &format!("{{\"rev\":{rev}}}"));
                        json(merged)
                    }
                    Some((_, _, rev)) => {
                        state.broadcast("config", &format!("{{\"rev\":{rev}}}"));
                        Response::empty(204).with_header(header("Access-Control-Allow-Origin", "*")).boxed()
                    }
                    None => Response::empty(500).with_header(header("Access-Control-Allow-Origin", "*")).boxed(),
                }
            }
            tiny_http::Method::Options => Response::empty(204)
                .with_header(header("Access-Control-Allow-Origin", "*"))
                .with_header(header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS"))
                .with_header(header("Access-Control-Allow-Headers", "Content-Type"))
                .boxed(),
            _ => Response::empty(405).boxed(),
        },
        _ => match asset(&path) {
            Some((bytes, mime)) => Response::from_data(bytes).with_header(header("Content-Type", mime)).boxed(),
            None => Response::empty(404).boxed(),
        },
    };
    let _ = req.respond(res);
}

/// Bind and start serving. Returns the port actually taken — the window title shows it, because
/// a fallback port nobody can see is a tablet that never connects.
pub fn serve(state: Arc<State>, want: u16) -> u16 {
    let server = Server::http(("0.0.0.0", want))
        .or_else(|_| Server::http(("0.0.0.0", DEFAULT_PORT)))
        .or_else(|_| Server::http("0.0.0.0:0"));
    let server = match server {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("weatherdesk: no HTTP port available ({e}); LAN dashboard is off");
            return 0;
        }
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(want);
    for _ in 0..WORKERS {
        let (server, state) = (server.clone(), state.clone());
        std::thread::spawn(move || {
            while let Ok(req) = server.recv() {
                handle(&state, req);
            }
        });
    }
    port
}

/// Address other LAN devices can reach us on. No packet is sent — connecting a UDP socket just
/// picks the outbound interface.
pub fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "localhost".into())
}

/// Listen to the hub's LAN broadcasts. Everything the websocket carries, minus the round trip
/// through WeatherFlow's cloud — and it keeps working when the internet doesn't.
///
/// This thread owns the only long-lived write connection: it takes the JSONL import on the way
/// in, then writes one row a minute forever.
pub fn listen_udp(state: Arc<State>) {
    let mut conn = store::open(&store::db_path(&state.data_dir)).ok();
    if let Some(c) = conn.as_mut() {
        store::migrate_jsonl(c, &state.data_dir.join("log"));
    }
    // ponytail: another Tempest app on the box owns the port first-come. Nothing to do but
    // skip; the page falls back to the websocket on its own.
    let sock = match UdpSocket::bind(("0.0.0.0", HUB_PORT)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("weatherdesk: UDP {HUB_PORT} unavailable ({e}); using websocket only");
            return;
        }
    };
    let mut buf = [0u8; 2048];
    loop {
        let Ok((n, _)) = sock.recv_from(&mut buf) else { continue };
        let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
        let Some(kind) = v.get("type").and_then(|t| t.as_str()).map(String::from) else { continue };
        if kind == "obs_st" {
            if let (Some(c), Some(obs)) = (conn.as_ref(), v.get("obs").and_then(|o| o.get(0)).and_then(|o| o.as_array())) {
                let tuple: Vec<Option<f64>> = obs.iter().map(|x| x.as_f64()).collect();
                store::insert(c, &tuple, store::SRC_UDP);
            }
        }
        // stamped on arrival so the page can tell a live packet from the last one before a
        // hub reboot
        if let Some(obj) = v.as_object_mut() {
            obj.insert("_at".into(), now().into());
        }
        let body = v.to_string();
        if let Ok(mut map) = state.packets.lock() {
            map.insert(kind, body.clone());
        }
        state.broadcast("udp", &body);
    }
}

/// Backfill the station's history from WeatherFlow, once, in the background.
pub fn start_backfill(state: Arc<State>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        let cfg: serde_json::Value =
            serde_json::from_str(&read_config(&state.cfg_path)).unwrap_or_else(|_| serde_json::json!({}));
        let s = |k: &str| cfg.pointer(&format!("/settings/{k}")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let Some(conn) = state.db() else { return };
        if store::meta_get(&conn, "backfill_done").is_some() {
            *state.backfill.lock().unwrap() = "done";
            return;
        }
        let (token, device) = (s("token"), s("deviceId"));
        if token.is_empty() || device.is_empty() {
            return;
        }
        *state.backfill.lock().unwrap() = "running";
        store::backfill(&conn, &token, &device);
        *state.backfill.lock().unwrap() = "done";
    });
}

// ponytail: the checks that matter here are the two protocol promises — a secret must never
// reach the public blob, and a v2 client's whole-blob write must keep working.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_day_and_time() {
        // 2023-11-14 22:13:20 UTC
        assert_eq!(utc_dhm(1_700_000_000), (14, 22, 13));
        assert_eq!(utc_dhm(0), (1, 0, 0));
        assert_eq!(utc_dhm(951_782_400), (29, 0, 0)); // leap day
    }

    #[test]
    fn public_config_keeps_no_secrets() {
        let out = redact(
            r#"{"settings":{"token":"abc123","mqttPass":"hunter2","ntfyTopic":"secret-topic",
                "stationId":"1234","lat":33.1,"units":"imperial"}}"#,
        );
        for needle in ["abc123", "hunter2", "secret-topic"] {
            assert!(!out.contains(needle), "{needle} leaked into the public config: {out}");
        }
        assert!(out.contains("1234") && out.contains("imperial"), "public config lost the station");
    }

    #[test]
    fn malformed_config_is_not_served_raw() {
        assert_eq!(redact("not json at all"), "{}");
    }

    #[test]
    fn old_clients_keep_writing_whole_blobs() {
        let dir = std::env::temp_dir().join(format!("wd-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let _ = std::fs::create_dir_all(&dir);

        let (code, _, rev) = write_config(&path, r#"{"settings":{"units":"imperial"}}"#).unwrap();
        assert_eq!((code, rev), (204, 1), "a v2 whole-blob PUT must still answer 204");

        // a v3 client changes one key and gets the merged blob back
        let (code, body, rev) = write_config(&path, r#"{"_rev":1,"layout":{"hero":0}}"#).unwrap();
        assert_eq!((code, rev), (200, 2));
        assert!(body.contains("imperial"), "delta write dropped an untouched key: {body}");
        assert!(body.contains("hero"));

        // and a v2 client writing the whole blob afterwards still wins outright
        let (_, _, _) = write_config(&path, r#"{"settings":{"units":"metric"}}"#).unwrap();
        let saved = read_config(&path);
        assert!(saved.contains("metric") && !saved.contains("hero"), "legacy write was merged: {saved}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
