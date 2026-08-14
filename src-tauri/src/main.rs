#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Header, Response, Server};

const PORT: u16 = 8088;
const HUB_PORT: u16 = 50222;

/// Latest broadcast per packet type, as received. Raw JSON: the page already knows the
/// Tempest tuple layouts, so re-modelling them in Rust would be two copies to keep in sync.
type Packets = Arc<Mutex<HashMap<String, String>>>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Listen to the hub's LAN broadcasts. Everything the websocket carries, minus the round trip
/// through WeatherFlow's cloud — and it keeps working when the internet doesn't.
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

fn udp_json(packets: &Packets) -> String {
    let map = packets.lock().map(|m| m.clone()).unwrap_or_default();
    let body: Vec<String> = map.iter().map(|(k, v)| format!("{}:{}", serde_json::Value::from(k.as_str()), v)).collect();
    format!("{{{}}}", body.join(","))
}

/// Address other LAN devices can reach us on. No packet is sent — connecting a
/// UDP socket just picks the outbound interface.
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "localhost".into())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
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

            let resolver = app.asset_resolver();
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
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
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(format!("WeatherDesk — tablet: http://{}:{}", lan_ip(), port))
                .inner_size(1280.0, 800.0)
                // the window isn't same-origin with the LAN server, so it needs the port told to it
                .initialization_script(&format!("window.__WD_UDP='http://localhost:{port}/udp'"))
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running WeatherDesk");
}
