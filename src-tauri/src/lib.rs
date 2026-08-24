// The app itself. `main.rs` is a shim over `run()` (or `run_headless()`), and the Android build
// links this as a library — that split is what `cargo tauri android init` expects.
//
// Everything the LAN server and the hub's UDP listener touch is desktop-only: a phone is not a
// server for the rest of the house, and Android sandboxes the broadcast port anyway. The page
// notices neither — `udp.js` gives up after three misses and stays on the websocket.
//
// The desktop half also builds without Tauri at all (`--no-default-features`): that binary is
// the Docker image, a dashboard for a house with no desktop in it.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod api;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod cwop;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod discover;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod ingest;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod mqtt;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod server;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod store;

#[cfg(feature = "gui")]
mod gui;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::PathBuf;

/// Where the archive and the settings blob live when nobody hands us Tauri's idea of it. Same
/// XDG paths Tauri uses, so a headless run and a desktop run on one box share their history;
/// `WD_DATA_DIR` overrides it, which is the whole of the Docker volume story.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn default_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WD_DATA_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".local/share/io.github.davidmay87.weatherdesk")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn default_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WD_DATA_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/io.github.davidmay87.weatherdesk")
}

/// Read one setting out of the config blob without a full settings type — the page owns that
/// schema, and mirroring it here would be a second copy to keep in step.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn setting(cfg_path: &std::path::Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(cfg_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let at = v.pointer(&format!("/settings/{key}"))?;
    Some(at.as_str().map(String::from).unwrap_or_else(|| at.to_string()))
}

/// The UDP listener, the archive and the LAN server — everything that runs whether or not there
/// is a window. Returns the port the dashboard ended up on.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn start_services(data_dir: PathBuf, cfg_path: PathBuf) -> (std::sync::Arc<server::State>, u16) {
    let want = setting(&cfg_path, "httpPort")
        .and_then(|v| v.trim_matches('"').parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(server::DEFAULT_PORT);
    let state = server::State::new(data_dir, cfg_path);
    let listener = state.clone();
    std::thread::spawn(move || server::listen_udp(listener));
    server::start_backfill(state.clone());
    cwop::start(state.data_dir.clone(), state.cfg_path.clone());
    cwop::start_relay(state.data_dir.clone(), state.cfg_path.clone());
    ingest::start_pollers(state.clone());
    mqtt::start(state.data_dir.clone(), state.cfg_path.clone());
    let port = server::serve(state.clone(), want);
    discover::start(port);
    (state, port)
}

/// No window, no Tauri: serve the LAN and log the hub forever.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn run_headless() {
    let (_state, port) = start_services(default_data_dir(), default_config_dir().join("config.json"));
    println!("weatherdesk: http://{}:{}", server::lan_ip(), port);
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(feature = "gui")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    gui::run();
}
