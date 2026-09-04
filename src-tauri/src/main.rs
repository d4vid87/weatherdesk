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
    // WebKitGTK renderer knobs. Which ones depend on the box: the AppImage runs under XWayland
    // and an Intel iGPU there draws a blank window unless compositing is software too. Mode comes
    // from `WD_RENDER`, `--render <mode>`, then the saved setting, so a blank window can be fixed
    // from any browser on the LAN. Only set what the user has not set themselves.
    #[cfg(target_os = "linux")]
    {
        let args: Vec<String> = std::env::args().collect();
        let flag = args.iter().position(|a| a == "--render").and_then(|i| args.get(i + 1)).cloned();
        let cfg = weatherdesk_lib::default_config_dir().join("config.json");
        let mode = std::env::var("WD_RENDER")
            .ok()
            .or(flag)
            .or_else(|| weatherdesk_lib::setting(&cfg, "render").map(|s| s.trim_matches('"').to_string()))
            .unwrap_or_else(|| "auto".into());
        let appimage = std::env::var_os("APPIMAGE").is_some();
        let vendor = weatherdesk_lib::gpu_vendor();
        let mut set = vec![];
        for (k, v) in weatherdesk_lib::render_env(&mode, appimage, vendor.as_deref()) {
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
                set.push(k);
            }
        }
        eprintln!(
            "weatherdesk: render={mode} appimage={appimage} gpu={} set={set:?}",
            vendor.as_deref().unwrap_or("unknown")
        );
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
