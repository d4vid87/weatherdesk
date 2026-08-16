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

/// Listen to the hub's LAN broadcasts. Everything the websocket carries, minus the round trip
/// through WeatherFlow's cloud — and it keeps working when the internet doesn't.
#[cfg(desktop)]
fn listen_udp(packets: Packets) {
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
                std::thread::spawn(move || listen_udp(listener));

                let cfg_path = app.path().app_config_dir().map(|d| d.join("config.json")).ok();

                let resolver = app.asset_resolver();
                std::thread::spawn(move || {
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
