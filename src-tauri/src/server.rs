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

use crate::ingest;
use crate::store;
use include_dir::{include_dir, Dir};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
static TEMP_N: AtomicUsize = AtomicUsize::new(0);

pub struct State {
    /// Latest broadcast per packet type, as received. Raw JSON: the page already knows the
    /// Tempest tuple layouts, so re-modelling them in Rust would be two copies to keep in sync.
    pub packets: Mutex<HashMap<String, String>>,
    pub cfg_path: PathBuf,
    pub data_dir: PathBuf,
    /// (tz, oldest ts, local midnight, everything before today) — see `/history/daily`. Today's
    /// row is appended per request; the head only changes when the day turns or history is pruned.
    daily: Mutex<Option<(i64, i64, i64, String)>>,
    /// The ingest path's connection, opened once and kept. Every reading used to open a fresh
    /// SQLite handle (file open, WAL header read, pragmas, schema check) a few times a second.
    /// ponytail: one writer mutex; per-thread connections if ingest ever exceeds a few rows/s.
    writer: Mutex<Option<rusqlite::Connection>>,
    sse: Mutex<Vec<SyncSender<String>>>,
    sse_n: AtomicUsize,
    pub backfill: Mutex<&'static str>,
    started: u64,
    pub maintenance: AtomicBool,
}

impl State {
    pub fn new(data_dir: PathBuf, cfg_path: PathBuf) -> Arc<State> {
        Arc::new(State {
            packets: Mutex::new(HashMap::new()),
            cfg_path,
            data_dir,
            daily: Mutex::new(None),
            writer: Mutex::new(None),
            sse: Mutex::new(Vec::new()),
            sse_n: AtomicUsize::new(0),
            backfill: Mutex::new("off"),
            started: now(),
            maintenance: AtomicBool::new(false),
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

    /// Run one write against the kept-open writer connection, opening it on first use.
    pub fn with_db<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> Option<T> {
        let mut slot = self.writer.lock().ok()?;
        if slot.is_none() {
            *slot = store::open(&store::db_path(&self.data_dir)).ok();
        }
        slot.as_ref().map(f)
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
    let (_, _, d, h, mi, _) = utc_ymdhms(epoch);
    (d, h, mi)
}

/// The same civil-from-days, with the year and month the Weather Underground protocol wants in
/// its `dateutc` (`YYYY-MM-DD HH:MM:SS`).
pub fn utc_ymdhms(epoch: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = epoch.div_euclid(86_400);
    let secs = epoch.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, (secs / 3600) as u32, ((secs % 3600) / 60) as u32, (secs % 60) as u32)
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
const SECRET_KEYS: [&str; 13] = [
    "token",
    "mqttUser",
    "mqttPass",
    "haToken",
    "ntfyTopic",
    "webhookUrl",
    // The other brands' credentials: two Ambient Weather Network keys, a La Crosse account,
    // and the shared secret a console puts in its upload path.
    "awnApiKey",
    "awnAppKey",
    "lacrosseEmail",
    "lacrossePass",
    "ingestKey",
    // Upload keys for the relay. The station ids are public (they name your station on both
    // sites); the keys are what stop anyone else from posting as you.
    "wuKey",
    "pwsKey",
];

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

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = path.parent() { std::fs::create_dir_all(d)?; }
    let tmp = path.with_extension(format!("json.tmp.{}", TEMP_N.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, text)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        // Windows does not replace an existing destination. Keep the old file until the new one
        // is in place, and put it back if that second rename fails.
        Err(_) if path.exists() => {
            let old = path.with_extension("json.prev");
            let _ = std::fs::remove_file(&old);
            std::fs::rename(path, &old)?;
            match std::fs::rename(&tmp, path) {
                Ok(()) => { let _ = std::fs::remove_file(old); Ok(()) }
                Err(next) => { let _ = std::fs::rename(old, path); Err(next) }
            }
        }
        Err(e) => Err(e),
    }
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
    write_atomic(path, &text).ok()?;
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

pub fn query(url: &str, key: &str) -> Option<String> {
    url.split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .map(String::from)
}

/// The archive window a `/history/tuples` request is asking for.
///
/// `hours` is the old contract and still the default; `from`+`to` is what a click on a chart
/// point sends. A week is the cap either way — the page draws pixels, not a data dump — and an
/// explicit range keeps its `to` end, because that is the moment the viewer clicked. Without a
/// `to` there is no upper bound at all: a hub whose clock runs a few seconds fast would otherwise
/// lose the newest row it just wrote.
pub fn window(url: &str, now: u64) -> (i64, i64) {
    let n = |k| query(url, k).and_then(|v| v.parse::<i64>().ok());
    match (n("from"), n("to")) {
        (Some(from), Some(to)) => (to.saturating_sub(168 * 3600).max(from), to),
        _ => {
            let hours = n("hours").unwrap_or(3).clamp(1, 168);
            (now as i64 - hours * 3600, i64::MAX)
        }
    }
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

/// Version plus length: the site is baked into the binary, so a file can only change when the
/// binary does — and a length catches a `WD_SITE_DIR` edit during development.
pub fn etag(len: usize) -> String {
    format!("\"{}-{}\"", env!("CARGO_PKG_VERSION"), len)
}

/// Fonts and icons never change under a given URL and a week is invisible to anyone. Code and
/// markup must always be revalidated, or a fixed bug would stay fixed only on the machines that
/// happened to go offline.
pub fn cache_policy(mime: &str) -> &'static str {
    match mime {
        "font/woff2" | "image/png" | "image/x-icon" | "image/jpeg" => "public, max-age=604800",
        _ => "no-cache",
    }
}

fn if_none_match(req: &tiny_http::Request) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("If-None-Match"))
        .map(|h| h.value.as_str().to_string())
}

fn not_modified(tag: &str, mime: &str) -> ResponseBox {
    Response::empty(304)
        .with_header(header("ETag", tag))
        .with_header(header("Cache-Control", cache_policy(mime)))
        .boxed()
}

/// The one place the running version comes from. Injected into every page we serve, and into
/// the desktop window separately (`gui.rs`) — that window loads the site over Tauri's asset
/// protocol and never touches this server.
pub fn ver_script() -> String {
    format!("window.__WD_VER='{}'", env!("CARGO_PKG_VERSION"))
}

/// Where this page should send its own requests.
///
/// Normally nowhere in particular: the page is served from the same origin as `/config` and
/// `/history`, so a bare path works and `__WD_SRV` stays empty. Home Assistant's Ingress is the
/// exception — it serves the add-on under `/api/hassio_ingress/<token>/` and tells us so in a
/// header, so a request to `/config` would leave the add-on entirely and 404 against Home
/// Assistant itself. Handing the page the prefix is the whole of Ingress support; every asset in
/// `index.html` is already a relative URL.
///
/// The token is Home Assistant's, changes per session, and is only ever echoed back into the page
/// that was served with it.
fn srv_script(req: &tiny_http::Request) -> String {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("X-Ingress-Path"))
        .and_then(|h| ingress_prefix(h.value.as_str()))
        .map(|p| format!("window.__WD_SRV='{p}';"))
        .unwrap_or_default()
}

/// A path prefix we are willing to write into a `<script>`, or nothing.
///
/// It goes inside a single-quoted JavaScript string, so anything that could end that string early
/// is refused outright rather than escaped: this value arrives in a header, and a header is
/// whatever the other end felt like sending. Ingress paths are `/api/hassio_ingress/<token>` and
/// contain none of it.
fn ingress_prefix(raw: &str) -> Option<String> {
    let p = raw.trim().trim_end_matches('/');
    if p.is_empty() || !p.starts_with('/') {
        return None;
    }
    if p.contains(['"', '\'', '\\', '<', '>', '\n', '\r']) {
        return None;
    }
    Some(p.to_string())
}

/// Every spelling a console might report on. Firmware varies more than the protocols do: some
/// Weather Underground clones post to `/updateweatherstation.php` with no prefix, some to
/// `/weatherstation/updateweatherstation.php?...`, and Ecowitt's `/data/report/` shows up with
/// and without its trailing slash. Answering all of them is free — `ingest::accept` rejects
/// anything that isn't a weather report, and `ingestKey` still applies.
fn is_ingest_path(path: &str) -> bool {
    path == "/ingest"
        || path.starts_with("/ingest/")
        || path.trim_end_matches('/') == "/data/report"
        || path.starts_with("/weatherstation/")
        || path == "/updateweatherstation.php"
}

fn staged_restore(state: &State, id: &str) -> Option<PathBuf> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') { return None; }
    Some(state.data_dir.join(format!("restore-{id}.wdbak")))
}

fn cleanup_restores(state: &State) {
    let Ok(files) = std::fs::read_dir(&state.data_dir) else { return };
    for entry in files.flatten() {
        let path = entry.path();
        let old = entry.metadata().ok().and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok()).map(|d| d.as_secs() > 3600).unwrap_or(false);
        if old && path.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("restore-") && n.ends_with(".wdbak")).unwrap_or(false) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn health_json(state: &State) -> String {
    let db = state.db();
    let archive = db.as_ref().map(|c| store::health(c, &store::db_path(&state.data_dir)))
        .unwrap_or_else(|| serde_json::json!({ "ok": false, "check": "unavailable" }));
    let diag = serde_json::from_str::<serde_json::Value>(&ingest::diag_json()).unwrap_or_default();
    let cfg = serde_json::from_str::<serde_json::Value>(&read_config(&state.cfg_path)).unwrap_or_default();
    let configured = |k: &str| cfg.pointer(&format!("/settings/{k}")).and_then(|v| v.as_str()).map(|v| !v.is_empty()).unwrap_or(false);
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"), "uptime": now().saturating_sub(state.started),
        "archive": archive, "ingest": diag,
        "integrations": {
            "mqtt": { "configured": configured("mqttUrl"), "ok": diag.pointer("/mqtt/ok").and_then(|v| v.as_bool()) },
            "homeAssistant": { "configured": configured("haUrl") && configured("haToken") },
            "push": { "configured": configured("ntfyTopic") || configured("webhookUrl") || configured("mqttUrl"),
                "ok": diag.pointer("/alerts/ok").and_then(|v| v.as_bool()) }
        },
        "backfill": *state.backfill.lock().unwrap_or_else(|e| e.into_inner())
    }).to_string()
}

fn handle(state: &Arc<State>, mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    if path == "/events" {
        sse(state, req);
        return;
    }

    // Where every other brand of station reports. `/ingest` is ours; the rest are the paths
    // consoles default to and can't always be talked out of, so we answer on those too.
    // A Weather Underground client checks the body for the literal `success`.
    if is_ingest_path(&path) {
        let mut body = String::new();
        // A station report is a few hundred bytes. The cap is what stops a stray POST of
        // something else from being read into memory in full.
        let _ = req.as_reader().take(64 * 1024).read_to_string(&mut body);
        let code = ingest::accept(state, &url, &body);
        let res = Response::from_string(if code == 200 { "success" } else { "" })
            .with_status_code(code)
            .with_header(header("Content-Type", "text/plain"));
        let _ = req.respond(res);
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
                .replace("<head>", &format!("<head><script>window.__WD_PUBLIC=1;{}</script>", ver_script()));
            Response::from_string(page).with_header(header("Content-Type", "text/html")).boxed()
        }
        // What each station source last did, for the drawer and for a screenshot in a bug
        // report. Fixed phrases and status codes only, so there is nothing here to gate.
        "/diag" => json(ingest::diag_json()),
        "/health" => json(health_json(state)),
        "/health/action" => {
            if *req.method() != tiny_http::Method::Post { Response::empty(405).boxed() } else {
                let mut body = String::new();
                let _ = req.as_reader().take(1024).read_to_string(&mut body);
                let action = serde_json::from_str::<serde_json::Value>(&body).ok()
                    .and_then(|v| v["action"].as_str().map(String::from));
                let ok = match action.as_deref() {
                    Some("checkpoint") => state.with_db(store::checkpoint).unwrap_or(false),
                    _ => false,
                };
                if ok { json("{\"ok\":true}".into()) } else { Response::empty(400).boxed() }
            }
        }
        // The versioned contract: named fields, SI, no credentials. Everything else here is
        // shaped for the page and free to change with it — this one isn't. See `api.rs`.
        "/api/v1" => json(crate::api::snapshot(state)),
        // WeatherLink Live consoles seen on the LAN, for the wizard's find button. Names and
        // addresses of hardware on this network only — nothing here that isn't already visible
        // to anything else plugged into it.
        // Try the broker and Home Assistant for real, and report in words. The credentials stay
        // in this process — the page never holds the token to make this call.
        "/ha/test" => json(crate::api::test_smart_home(&state.cfg_path)),
        // One real notification down every configured channel. Real on purpose: a test that
        // takes a different path to the phone from the alerts tests nothing.
        "/alerts/test" => json(crate::alerts::test_push(&state.cfg_path)),
        // Home Assistant's entity list, read with the token this process holds. The browser
        // never sees the token, and the CORS configuration most installs never edited stops
        // mattering — the fetch is same-origin now.
        "/ha/states" => json(crate::api::ha_states(&state.cfg_path)),
        "/discover/wll" => {
            let hosts = crate::discover::wll_hosts();
            json(serde_json::json!(hosts
                .iter()
                .map(|(n, a)| serde_json::json!({ "name": n, "host": a }))
                .collect::<Vec<_>>())
            .to_string())
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
        // The US Drought Monitor, via the FCC's county lookup. Neither serves CORS headers, and
        // the coordinates in both URLs are the house — see api::drought.
        "/proxy/drought" => json(crate::api::drought(&state.cfg_path)),
        "/history/daily" => {
            // Clamped: a hostile `tz` must not overflow the day arithmetic and panic a worker,
            // and a panicked worker is never replaced. ±14 h is the widest real offset.
            let tz = query(&url, "tz").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).clamp(-840, 840);
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let (min, _max) = store::stamp(&conn);
            let ds = store::day_start(now() as i64, tz);
            // The lock is not held across the query: a slow aggregate would otherwise block
            // every other screen asking the same question.
            // Backfill writes past days while it runs, which nothing in the key can see: no cache
            // until it is done.
            let filling = *state.backfill.lock().unwrap() == "running";
            let hit = {
                let cache = state.daily.lock().unwrap();
                match cache.as_ref() {
                    Some((t, c, d, head)) if !filling && (*t, *c, *d) == (tz, min, ds) => Some(head.clone()),
                    _ => None,
                }
            };
            // The head is every day but today: a full-table aggregate, and one that cannot change
            // until midnight or a prune. Today's row is a primary-key range scan, cheap enough to
            // redo per request — which is what keeps the archive's growth off this endpoint.
            let head = hit.unwrap_or_else(|| {
                let fresh = store::daily_head_json(&conn, tz, ds);
                if !filling {
                    *state.daily.lock().unwrap() = Some((tz, min, ds, fresh.clone()));
                }
                fresh
            });
            let body = store::daily_join(&head, store::daily_today_row(&conn, tz, ds).as_deref());
            json(body)
        }
        // The raw archive, SI, in `store::FIELDS` order. `/history/daily` answers the almanac's
        // question; this one answers the Data tab's, which for a non-Tempest station is the only
        // way to draw a trend — there is no cloud to ask.
        "/history/tuples" => {
            let (from, to) = window(&url, now());
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            json(store::tuples_json(&conn, from, to))
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
        "/backup.wdbak" => {
            let Some(conn) = state.db() else { return drop(req.respond(Response::empty(503))) };
            let dest = state.data_dir.join(format!("backup-{}-{}.wdbak", now(), TEMP_N.fetch_add(1, Ordering::Relaxed)));
            if store::bundle_to(&conn, &dest, &read_config(&state.cfg_path)).is_err() {
                return drop(req.respond(Response::empty(500)));
            }
            let Ok(file) = std::fs::File::open(&dest) else { return drop(req.respond(Response::empty(500))) };
            let len = file.metadata().map(|m| m.len() as usize).ok();
            let res = Response::new(tiny_http::StatusCode(200), vec![
                header("Content-Type", "application/octet-stream"),
                header("Content-Disposition", "attachment; filename=weatherdesk.wdbak"),
            ], file, len, None);
            std::thread::spawn(move || { let _ = req.respond(res); let _ = std::fs::remove_file(dest); });
            return;
        }
        "/restore/inspect" => {
            if *req.method() != tiny_http::Method::Post { Response::empty(405).boxed() } else {
                cleanup_restores(state);
                let id = format!("{}-{}-{}", now(), std::process::id(), TEMP_N.fetch_add(1, Ordering::Relaxed));
                let path = staged_restore(state, &id).unwrap();
                let result = std::fs::File::create(&path).and_then(|mut f| {
                    let n = std::io::copy(&mut req.as_reader().take(8 * 1024 * 1024 * 1024), &mut f)?;
                    if n == 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "empty")); }
                    f.flush()
                });
                match result.ok().and_then(|_| store::inspect_bundle(&path).ok()) {
                    Some(summary) => json(serde_json::json!({ "ok": true, "id": id, "summary": summary }).to_string()),
                    None => { let _ = std::fs::remove_file(path); json("{\"ok\":false,\"error\":\"Backup is invalid or unsupported\"}".into()) }
                }
            }
        }
        "/restore/apply" => {
            if *req.method() != tiny_http::Method::Post { Response::empty(405).boxed() } else {
                let id = query(&url, "id").unwrap_or_default();
                let Some(path) = staged_restore(state, &id).filter(|p| p.is_file()) else {
                    return drop(req.respond(Response::empty(404)));
                };
                let valid = store::inspect_bundle(&path).is_ok();
                let config = store::bundle_config(&path).ok();
                let old_config = read_config(&state.cfg_path);
                // VACUUM INTO refuses to overwrite. Use a private working name, then promote the
                // successful snapshot to the stable recovery filename after the restore commits.
                let recovery = state.data_dir.join(format!("pre-restore-{}.wdbak", TEMP_N.fetch_add(1, Ordering::Relaxed)));
                let kept_recovery = state.data_dir.join("pre-restore.wdbak");
                state.maintenance.store(true, Ordering::Relaxed);
                let applied = valid && config.as_ref().map(|new_config| state.with_db(|conn| {
                    if store::bundle_to(conn, &recovery, &old_config).is_err() { return false; }
                    if store::replace_from_bundle(conn, &path).is_err() { return false; }
                    if write_atomic(&state.cfg_path, new_config).is_err() {
                        let _ = store::replace_from_bundle(conn, &recovery);
                        return false;
                    }
                    true
                }).unwrap_or(false)).unwrap_or(false);
                state.maintenance.store(false, Ordering::Relaxed);
                if applied {
                    let _ = std::fs::remove_file(&kept_recovery);
                    let _ = std::fs::rename(&recovery, &kept_recovery);
                    *state.daily.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    state.broadcast("config", "{\"restore\":true}");
                    let _ = std::fs::remove_file(path);
                    json("{\"ok\":true}".into())
                } else {
                    let _ = std::fs::remove_file(recovery);
                    json("{\"ok\":false,\"error\":\"Restore failed; current data was kept\"}".into())
                }
            }
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
            // The page has no other way to know what it is: the site is baked in and the
            // version lives in the binary.
            Some((bytes, "text/html")) => {
                let page = String::from_utf8_lossy(&bytes).replace(
                    "<head>",
                    &format!("<head><script>{}{}</script>", srv_script(&req), ver_script()),
                );
                let tag = etag(page.len());
                if if_none_match(&req).as_deref() == Some(tag.as_str()) {
                    not_modified(&tag, "text/html")
                } else {
                    Response::from_string(page)
                        .with_header(header("Content-Type", "text/html"))
                        .with_header(header("ETag", &tag))
                        .with_header(header("Cache-Control", cache_policy("text/html")))
                        .boxed()
                }
            }
            Some((bytes, mime)) => {
                let tag = etag(bytes.len());
                if if_none_match(&req).as_deref() == Some(tag.as_str()) {
                    not_modified(&tag, mime)
                } else {
                    Response::from_data(bytes)
                        .with_header(header("Content-Type", mime))
                        .with_header(header("ETag", &tag))
                        .with_header(header("Cache-Control", cache_policy(mime)))
                        .boxed()
                }
            }
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
            if !state.maintenance.load(Ordering::Relaxed) {
              if let (Some(c), Some(obs)) = (conn.as_ref(), v.get("obs").and_then(|o| o.get(0)).and_then(|o| o.as_array())) {
                let tuple: Vec<Option<f64>> = obs.iter().map(|x| x.as_f64()).collect();
                store::insert(c, &tuple, store::SRC_UDP);
              }
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
        // The cloud just wrote days that are all before today: the cached head is wrong now.
        *state.daily.lock().unwrap() = None;
    });
}

// ponytail: the checks that matter here are the two protocol promises — a secret must never
// reach the public blob, and a v2 client's whole-blob write must keep working.
#[cfg(test)]
mod tests {
    use super::*;

    /// The window a history request asks for: the old `hours` contract, and the explicit range a
    /// click on a chart point sends — capped, but from the end the viewer clicked.
    #[test]
    fn tuples_window_defaults_to_hours_and_caps_an_explicit_range() {
        let now = 1_700_000_000u64;
        assert_eq!(window("/history/tuples", now), (now as i64 - 3 * 3600, i64::MAX));
        assert_eq!(window("/history/tuples?hours=48", now), (now as i64 - 48 * 3600, i64::MAX));
        // Out of range and nonsense both fall back inside the clamp rather than scanning the archive.
        assert_eq!(window("/history/tuples?hours=100000", now), (now as i64 - 168 * 3600, i64::MAX));
        assert_eq!(window("/history/tuples?hours=x", now), (now as i64 - 3 * 3600, i64::MAX));
        assert_eq!(window("/history/tuples?from=100&to=200", now), (100, 200));
        let (from, to) = window("/history/tuples?from=0&to=1000000000", now);
        assert_eq!((from, to), (1_000_000_000 - 168 * 3600, 1_000_000_000));
    }

    /// The header contract, end to end: a real request over a real socket, because the etag and
    /// the cache policy are only worth anything if they reach the wire.
    #[test]
    fn assets_carry_an_etag_and_answer_304() {
        use std::io::{BufRead, BufReader, Write};
        let dir = std::env::temp_dir().join(format!("wd-test-{}", std::process::id()));
        let state = State::new(dir.clone(), dir.join("config.json"));
        let port = serve(state, 0);
        assert!(port > 0, "no port available for the test server");

        let get = |extra: &str| -> (String, Vec<String>) {
            let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(sock, "GET /js/motion.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{extra}\r\n").unwrap();
            let mut r = BufReader::new(sock);
            let mut status = String::new();
            r.read_line(&mut status).unwrap();
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                headers.push(line.trim().to_string());
            }
            (status, headers)
        };

        let (status, headers) = get("");
        assert!(status.contains("200"), "{status}");
        let tag = headers
            .iter()
            .find_map(|h| h.strip_prefix("ETag: "))
            .expect("no ETag on a served asset")
            .to_string();
        assert!(headers.iter().any(|h| h == "Cache-Control: no-cache"), "{headers:?}");

        let (status, _) = get(&format!("If-None-Match: {tag}\r\n"));
        assert!(status.contains("304"), "a matching etag should be answered 304, got {status}");
    }

    /// The etag is keyed on what can actually change: the binary's version, and the file's
    /// length for a WD_SITE_DIR edit during development.
    #[test]
    fn etag_keyed_on_version_and_length() {
        assert_eq!(etag(10), etag(10));
        assert_ne!(etag(10), etag(11));
        assert!(etag(10).starts_with(&format!("\"{}-", env!("CARGO_PKG_VERSION"))));
    }

    /// Code and markup are always revalidated; only immutable assets get a long life.
    #[test]
    fn cache_policy_by_mime() {
        assert_eq!(cache_policy("font/woff2"), "public, max-age=604800");
        assert_eq!(cache_policy("image/png"), "public, max-age=604800");
        assert_eq!(cache_policy("text/html"), "no-cache");
        assert_eq!(cache_policy("text/javascript"), "no-cache");
        // An animated icon is an SVG, and SVGs are also how the site draws its own gauges —
        // revalidating them costs one conditional request and keeps a fix deployable.
        assert_eq!(cache_policy("image/svg+xml"), "no-cache");
    }

    #[test]
    fn utc_day_and_time() {
        // 2023-11-14 22:13:20 UTC
        assert_eq!(utc_dhm(1_700_000_000), (14, 22, 13));
        assert_eq!(utc_dhm(0), (1, 0, 0));
        assert_eq!(utc_dhm(951_782_400), (29, 0, 0)); // leap day
        assert_eq!(utc_ymdhms(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(utc_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(utc_ymdhms(951_782_400), (2000, 2, 29, 0, 0, 0));
    }

    /// Ray's Vevor 60234 reports on a path we used not to answer. Every spelling in this list
    /// came off a real console; the negatives are the routes the app itself owns.
    #[test]
    fn every_console_spelling_reaches_ingest() {
        for p in [
            "/ingest",
            "/ingest/pushpin",
            "/data/report",
            "/data/report/",
            "/weatherstation/updateweatherstation.php",
            "/updateweatherstation.php",
        ] {
            assert!(is_ingest_path(p), "{p} should reach ingest");
        }
        for p in ["/config", "/public", "/", "/history/daily", "/diag"] {
            assert!(!is_ingest_path(p), "{p} must not be swallowed by ingest");
        }
    }

    /// This value ends up inside a single-quoted JavaScript string in a page we serve, and it
    /// arrives in a header. Anything that could close that string early is refused, not escaped.
    #[test]
    fn an_ingress_prefix_cannot_break_out_of_the_script_it_lands_in() {
        assert_eq!(
            ingress_prefix("/api/hassio_ingress/abc123/"),
            Some("/api/hassio_ingress/abc123".to_string())
        );
        assert_eq!(ingress_prefix("/x';alert(1);//"), None);
        assert_eq!(ingress_prefix("/x\"></script><script>"), None);
        assert_eq!(ingress_prefix("/x\\"), None);
        assert_eq!(ingress_prefix("/a\nb"), None);
        assert_eq!(ingress_prefix("http://evil.example"), None, "must be a path, not an origin");
        assert_eq!(ingress_prefix(""), None);
        assert_eq!(ingress_prefix("/"), None);
    }

    #[test]
    fn public_config_keeps_no_secrets() {
        let out = redact(
            r#"{"settings":{"token":"abc123","mqttPass":"hunter2","ntfyTopic":"secret-topic",
                "awnApiKey":"awn-key","awnAppKey":"awn-app","lacrossePass":"lax-pw","ingestKey":"pushpin",
                "wuKey":"wu-pw","pwsKey":"pws-pw",
                "stationId":"1234","lat":33.1,"units":"imperial"}}"#,
        );
        for needle in ["abc123", "hunter2", "secret-topic", "awn-key", "awn-app", "lax-pw", "pushpin", "wu-pw", "pws-pw"] {
            assert!(!out.contains(needle), "{needle} leaked into the public config: {out}");
        }
        assert!(out.contains("1234") && out.contains("imperial"), "public config lost the station");
    }

    #[test]
    fn malformed_config_is_not_served_raw() {
        assert_eq!(redact("not json at all"), "{}");
    }

    #[test]
    fn health_report_reveals_configuration_state_not_secrets() {
        let dir = std::env::temp_dir().join(format!("wd-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        std::fs::write(&cfg, r#"{"settings":{"token":"tempest-secret","mqttUrl":"mqtt://broker","mqttPass":"broker-secret","haUrl":"http://ha","haToken":"ha-secret","ntfyTopic":"push-secret"}}"#).unwrap();
        let state = State::new(dir.clone(), cfg);
        let out = health_json(&state);
        for secret in ["tempest-secret", "broker-secret", "ha-secret", "push-secret", "mqtt://broker", "http://ha"] {
            assert!(!out.contains(secret), "health leaked {secret}: {out}");
        }
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.pointer("/integrations/mqtt/configured").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.pointer("/integrations/homeAssistant/configured").and_then(|x| x.as_bool()), Some(true));
        let _ = std::fs::remove_dir_all(dir);
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
