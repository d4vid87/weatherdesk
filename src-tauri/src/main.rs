#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point only. Everything lives in `lib.rs`, which the Android build links directly.
// `--headless` is the same process without a window — a LAN dashboard on a box with no desktop,
// which is also all the Docker image is.
fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("WeatherDesk {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    // Headless health check for a Pi with no browser: ask the running server, print what it
    // says, exit non-zero if it is down or has never seen a reading.
    if std::env::args().any(|a| a == "--check") {
        std::process::exit(check());
    }
    if std::env::args().any(|a| a == "--headless") {
        return weatherdesk_lib::run_headless();
    }
    #[cfg(feature = "gui")]
    weatherdesk_lib::run();
    #[cfg(not(feature = "gui"))]
    weatherdesk_lib::run_headless();
}

fn check() -> i32 {
    let cfg = weatherdesk_lib::default_config_dir().join("config.json");
    let port = weatherdesk_lib::setting(&cfg, "httpPort")
        .and_then(|p| p.trim_matches('"').parse::<u16>().ok())
        .unwrap_or(8088);
    let body = match ureq::get(&format!("http://127.0.0.1:{port}/api/v1"))
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
    {
        Some(b) => b,
        None => {
            eprintln!("no server answering on port {port}");
            return 1;
        }
    };
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let source = v["station"]["source"].as_str().unwrap_or("tempest");
    match v["current"]["time"].as_i64() {
        Some(t) => {
            let age = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
                - t)
                / 60;
            println!("source: {source} — last reading {age} min ago");
            0
        }
        None => {
            eprintln!("source: {source} — no reading has landed yet");
            1
        }
    }
}
