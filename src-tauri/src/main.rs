#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::UdpSocket;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Header, Response, Server};

const PORT: u16 = 8088;

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
            let resolver = app.asset_resolver();
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
                    let path = req.url().split('?').next().unwrap_or("/").to_string();
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

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://localhost:{port}").parse()?),
            )
            .title(format!("WeatherDesk — tablet: http://{}:{}", lan_ip(), port))
            .inner_size(1280.0, 800.0)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running WeatherDesk");
}
