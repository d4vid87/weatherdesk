// The app itself. `main.rs` is a two-line shim over `run()`, and the Android build links this as a
// library — that split is what `cargo tauri android init` expects, and the only reason it exists.
//
// Everything the LAN server and the hub's UDP listener touch is desktop-only: a phone is not a
// server for the rest of the house, and Android sandboxes the broadcast port anyway. The page
// notices neither — `udp.js` gives up after three misses and stays on the websocket.

#[cfg(desktop)]
use std::collections::HashMap;
#[cfg(desktop)]
use std::io::Read;
#[cfg(desktop)]
use std::net::UdpSocket;
#[cfg(desktop)]
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tiny_http::{Header, Response, Server};

#[cfg(desktop)]
const PORT: u16 = 8088;
#[cfg(desktop)]
const HUB_PORT: u16 = 50222;

/// Latest broadcast per packet type, as received. Raw JSON: the page already knows the
/// Tempest tuple layouts, so re-modelling them in Rust would be two copies to keep in sync.
#[cfg(desktop)]
type Packets = Arc<Mutex<HashMap<String, String>>>;

#[cfg(desktop)]
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Civil date from a day number since the epoch (Howard Hinnant's algorithm). std has no
/// calendar and this is the whole of what the log needs — a date crate for six lines would be
/// a dependency to keep updated forever.
#[cfg(desktop)]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` for an epoch second, shifted by `tz_off_min` minutes east of UTC.
#[cfg(desktop)]
fn ymd(epoch: i64, tz_off_min: i64) -> (i64, u32, u32) {
    civil_from_days((epoch + tz_off_min * 60).div_euclid(86_400))
}

/// Where the raw observation log lives. One file per month keeps any single file openable in a
/// text editor; the whole thing is ~15 MB a year and is never rotated away.
#[cfg(desktop)]
fn log_file(dir: &std::path::Path, epoch: i64) -> std::path::PathBuf {
    let (y, m, _) = ymd(epoch, 0);
    dir.join(format!("obs-{y:04}-{m:02}.jsonl"))
}

/// Append one raw `obs_st` observation tuple as a JSON line. SI throughout, exactly as the hub
/// broadcast it — conversion is the page's job and it already does it in one place.
#[cfg(desktop)]
fn log_obs(dir: &std::path::Path, obs: &serde_json::Value) {
    use std::io::Write;
    let Some(ts) = obs.get(0).and_then(|v| v.as_i64()) else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_file(dir, ts)) else {
        return;
    };
    let _ = writeln!(f, "{obs}");
}

/// Every logged tuple, oldest file first. Lines that don't parse are skipped rather than
/// fatal: a half-written last line after a power cut should cost one minute, not the archive.
#[cfg(desktop)]
fn read_log(dir: &std::path::Path) -> Vec<Vec<Option<f64>>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(line) else { continue };
            out.push(v.iter().map(|x| x.as_f64()).collect());
        }
    }
    out
}

/// Per-day aggregates, SI, keyed by the viewer's local date — the browser passes its own UTC
/// offset because the process has no notion of a timezone and "yesterday" has to mean the same
/// day the user saw.
#[cfg(desktop)]
fn daily_json(dir: &std::path::Path, tz_off_min: i64) -> String {
    // obs_st tuple indices, same map as site/js/api.js OBS
    const TIME: usize = 0;
    const GUST: usize = 3;
    const TEMP: usize = 7;
    const RAIN: usize = 12;
    const STRIKES: usize = 15;
    const BATT: usize = 16;
    let get = |o: &Vec<Option<f64>>, i: usize| o.get(i).copied().flatten();

    let mut days: std::collections::BTreeMap<String, [Option<f64>; 6]> = Default::default();
    for o in read_log(dir) {
        let Some(t) = get(&o, TIME) else { continue };
        let (y, m, d) = ymd(t as i64, tz_off_min);
        let row = days.entry(format!("{y:04}-{m:02}-{d:02}")).or_insert([None; 6]);
        let lo = |a: &mut Option<f64>, v: Option<f64>| {
            if let Some(v) = v {
                *a = Some(a.map_or(v, |x: f64| x.min(v)));
            }
        };
        let hi = |a: &mut Option<f64>, v: Option<f64>| {
            if let Some(v) = v {
                *a = Some(a.map_or(v, |x: f64| x.max(v)));
            }
        };
        let sum = |a: &mut Option<f64>, v: Option<f64>| {
            if let Some(v) = v {
                *a = Some(a.unwrap_or(0.0) + v);
            }
        };
        let (t_lo, t_hi, g, r, s, b) = (get(&o, TEMP), get(&o, TEMP), get(&o, GUST), get(&o, RAIN), get(&o, STRIKES), get(&o, BATT));
        lo(&mut row[0], t_lo);
        hi(&mut row[1], t_hi);
        hi(&mut row[2], g);
        sum(&mut row[3], r);
        sum(&mut row[4], s);
        lo(&mut row[5], b);
    }
    let n = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
    let rows: Vec<String> = days
        .iter()
        .map(|(day, r)| {
            format!(
                "{{\"day\":\"{day}\",\"tempMin\":{},\"tempMax\":{},\"gustMax\":{},\"rain\":{},\"strikes\":{},\"battMin\":{}}}",
                n(r[0]), n(r[1]), n(r[2]), n(r[3]), n(r[4]), n(r[5])
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

/// Total bytes of the log. The archive is append-only, so this is a sound cache key.
#[cfg(desktop)]
fn log_size(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// The whole log as CSV, SI, header row. Built in memory: a decade of minutes is still only
/// tens of MB, and this is a button a user presses by hand.
#[cfg(desktop)]
fn history_csv(dir: &std::path::Path) -> String {
    let mut out = String::from(
        "time,wind_lull,wind_avg,wind_gust,wind_dir,wind_interval,pressure,temp,humidity,lux,uv,solar,rain,precip_type,strike_dist,strikes,battery,report_interval,day_rain\n",
    );
    for o in read_log(dir) {
        let row: Vec<String> = (0..19)
            .map(|i| o.get(i).copied().flatten().map(|v| v.to_string()).unwrap_or_default())
            .collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// Listen to the hub's LAN broadcasts. Everything the websocket carries, minus the round trip
/// through WeatherFlow's cloud — and it keeps working when the internet doesn't.
#[cfg(desktop)]
fn listen_udp(packets: Packets, log_dir: Option<std::path::PathBuf>) {
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
    // The hub re-broadcasts; without this the archive gets the same minute several times.
    let mut last_logged: i64 = 0;
    loop {
        let Ok((n, _)) = sock.recv_from(&mut buf) else { continue };
        let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
        let Some(kind) = v.get("type").and_then(|t| t.as_str()).map(String::from) else { continue };
        if kind == "obs_st" {
            if let (Some(dir), Some(obs)) = (log_dir.as_ref(), v.get("obs").and_then(|o| o.get(0))) {
                let ts = obs.get(0).and_then(|t| t.as_i64()).unwrap_or(0);
                if ts > last_logged {
                    last_logged = ts;
                    log_obs(dir, obs);
                }
            }
        }
        // stamped on arrival so the page can tell a live packet from the last one before a
        // hub reboot
        if let Some(obj) = v.as_object_mut() {
            obj.insert("_at".into(), now().into());
        }
        if let Ok(mut map) = packets.lock() {
            map.insert(kind, v.to_string());
        }
    }
}

#[cfg(desktop)]
fn udp_json(packets: &Packets) -> String {
    let map = packets.lock().map(|m| m.clone()).unwrap_or_default();
    let body: Vec<String> = map.iter().map(|(k, v)| format!("{}:{}", serde_json::Value::from(k.as_str()), v)).collect();
    format!("{{{}}}", body.join(","))
}

/// Address other LAN devices can reach us on. No packet is sent — connecting a
/// UDP socket just picks the outbound interface.
#[cfg(desktop)]
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "localhost".into())
}

/// One settings+layout blob for the whole house. Anything on the LAN can read it — same trust
/// model as the CORS-`*` `/udp` route — and that includes the Tempest token.
#[cfg(desktop)]
fn cors(res: Response<std::io::Empty>) -> Response<std::io::Empty> {
    res.with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
}

/// Strip every credential out of the settings blob for the public dashboard.
///
/// Deny by key name, and the keys are listed here rather than derived: a future setting that
/// holds a secret has to be added to this list, and a test below fails loudly if the token ever
/// survives. Anything not recognised is kept — the public page still needs the station's
/// coordinates and units to render.
#[cfg(desktop)]
const SECRET_KEYS: [&str; 6] = ["token", "mqttUser", "mqttPass", "haToken", "ntfyTopic", "webhookUrl"];

#[cfg(desktop)]
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

// ponytail: one check, on the only maths here that can be silently wrong — a day boundary off
// by one puts "yesterday's high" on the wrong row and nothing else complains.
#[cfg(all(test, desktop))]
mod tests {
    use super::{redact, ymd};

    #[test]
    fn day_boundaries() {
        assert_eq!(ymd(0, 0), (1970, 1, 1));
        assert_eq!(ymd(1_700_000_000, 0), (2023, 11, 14));
        // 04:00 UTC is still the previous day in US Central (-300 min)
        assert_eq!(ymd(1_700_020_800, -300), (2023, 11, 14));
        assert_eq!(ymd(1_700_020_800, 0), (2023, 11, 15));
        assert_eq!(ymd(951_782_400, 0), (2000, 2, 29)); // leap day
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[allow(unused_mut)]
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::default());

            #[cfg(desktop)]
            {
                // ponytail: port 8088 with a random-port fallback. Enough for one box;
                // make it configurable if users ever need a fixed alternate port.
                let server = Server::http(("0.0.0.0", PORT))
                    .or_else(|_| Server::http("0.0.0.0:0"))
                    .map_err(|e| e.to_string())?;
                let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(PORT);

                // The site is embedded by `frontendDist`; the resolver already handles
                // "/" -> index.html, percent-decoding and MIME types.
                let packets: Packets = Arc::new(Mutex::new(HashMap::new()));
                let listener = packets.clone();
                let log_dir = app.path().app_data_dir().map(|d| d.join("log")).ok();
                let listen_log = log_dir.clone();
                std::thread::spawn(move || listen_udp(listener, listen_log));

                let cfg_path = app.path().app_config_dir().map(|d| d.join("config.json")).ok();

                let resolver = app.asset_resolver();
                std::thread::spawn(move || {
                    // (tz offset, total log bytes, body) — see the /history/daily route.
                    let mut daily_cache: Option<(i64, u64, String)> = None;
                    for mut req in server.incoming_requests() {
                        let path = req.url().split('?').next().unwrap_or("/").to_string();
                        // ponytail: a plain polled route, not SSE — this request loop is
                        // single-threaded, and a hanging stream would stall every other asset.
                        if path == "/udp" {
                            let body = udp_json(&packets);
                            // the app window is a tauri://localhost origin, so it's cross-origin here
                            let _ = req.respond(
                                Response::from_string(body)
                                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                                    .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
                            );
                            continue;
                        }
                        // A read-only dashboard for anyone on the network — the family tablet,
                        // a guest phone, a reverse proxy to the outside world. Same config, with
                        // every secret taken out of it, and a flag the page uses to hide the
                        // settings drawer.
                        if path == "/public" || path == "/config-public" {
                            let body = std::fs::read_to_string(cfg_path.clone().unwrap_or_default())
                                .unwrap_or_else(|_| "{}".into());
                            let public = redact(&body);
                            if path == "/config-public" {
                                let _ = req.respond(
                                    Response::from_string(public)
                                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
                                );
                                continue;
                            }
                            let page = resolver
                                .get("/index.html".into())
                                .map(|a| String::from_utf8_lossy(&a.bytes).into_owned())
                                .unwrap_or_default()
                                .replace("<head>", "<head><script>window.__WD_PUBLIC=1</script>");
                            let _ = req.respond(
                                Response::from_string(page)
                                    .with_header(Header::from_bytes("Content-Type", "text/html").unwrap()),
                            );
                            continue;
                        }
                        if path == "/history/daily" || path == "/history.csv" {
                            let Some(dir) = log_dir.clone() else {
                                let _ = req.respond(Response::empty(503));
                                continue;
                            };
                            // `?tz=<minutes east of UTC>`; absent means UTC days.
                            let tz = req
                                .url()
                                .split('?')
                                .nth(1)
                                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("tz=")))
                                .and_then(|v| v.parse::<i64>().ok())
                                .unwrap_or(0);
                            let (body, mime) = if path == "/history.csv" {
                                (history_csv(&dir), "text/csv")
                            } else {
                                // Re-reading a year of minutes on every Data-tab visit would
                                // stall this loop — and it serves the page's assets too. The
                                // log only ever grows, so its total size is the whole cache key.
                                let size = log_size(&dir);
                                if daily_cache.as_ref().map(|(t, s, _)| (*t, *s)) != Some((tz, size)) {
                                    daily_cache = Some((tz, size, daily_json(&dir, tz)));
                                }
                                (daily_cache.as_ref().unwrap().2.clone(), "application/json")
                            };
                            let _ = req.respond(
                                Response::from_string(body)
                                    .with_header(Header::from_bytes("Content-Type", mime).unwrap())
                                    .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
                            );
                            continue;
                        }
                        if path == "/config" {
                            let Some(file) = cfg_path.clone() else {
                                let _ = req.respond(Response::empty(503));
                                continue;
                            };
                            match *req.method() {
                                tiny_http::Method::Get => {
                                    let body = std::fs::read_to_string(&file).unwrap_or_else(|_| "{}".into());
                                    let _ = req.respond(
                                        Response::from_string(body)
                                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                                            .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()),
                                    );
                                }
                                tiny_http::Method::Put => {
                                    let mut body = String::new();
                                    // capped: this loop is single-threaded, and the blob is a few KB
                                    let ok = req.as_reader().take(256 * 1024).read_to_string(&mut body).is_ok()
                                        && file.parent().map(|d| std::fs::create_dir_all(d).is_ok()).unwrap_or(false)
                                        && std::fs::write(&file, body).is_ok();
                                    let _ = req.respond(cors(Response::empty(if ok { 204 } else { 500 })));
                                }
                                tiny_http::Method::Options => {
                                    let _ = req.respond(
                                        cors(Response::empty(204))
                                            .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, PUT, OPTIONS").unwrap())
                                            .with_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap()),
                                    );
                                }
                                _ => { let _ = req.respond(Response::empty(405)); }
                            }
                            continue;
                        }
                        let _ = match resolver.get(path) {
                            Some(asset) => {
                                let header =
                                    Header::from_bytes("Content-Type", asset.mime_type).unwrap();
                                req.respond(Response::from_data(asset.bytes).with_header(header))
                            }
                            None => req.respond(Response::empty(404)),
                        };
                    }
                });

                // The window loads through Tauri's own asset protocol, not the LAN server: the
                // server's port moves when 8088 is taken, and WebKit keys localStorage per origin,
                // so a moving port would wipe the token and layout on every restart.
                win = win
                    .title(format!("WeatherDesk — tablet: http://{}:{}", lan_ip(), port))
                    .inner_size(1280.0, 800.0)
                    // Start maximized on Linux: KWin maximizes a restored window after mapping
                    // it, and GTK can miss that configure entirely — the webview then paints at
                    // the startup size in the corner of a full-screen window, with no way for
                    // the process to notice. Owning the state from the first frame sidesteps it.
                    .maximized(cfg!(target_os = "linux"))
                    // the window isn't same-origin with the LAN server, so it needs the port told to it
                    .initialization_script(&format!(
                        "window.__WD_UDP='http://localhost:{port}/udp';window.__WD_SRV='http://localhost:{port}'"
                    ));
            }

            win.build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running WeatherDesk");
}
