// The desktop/Android window, and nothing else. Everything this file needs from the LAN server
// it gets through `start_services`, so the headless build never compiles any of it.

use tauri::{WebviewUrl, WebviewWindowBuilder};

// The tray, the server and the paths behind them are desktop-only, and so is everything imported
// for them — Android builds warn about each one otherwise.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// The current temperature, next to the clock, without a window in the way. Linux app
/// indicators quietly drop tooltips, so the same string goes in the title too — on ayatana that
/// is what actually shows, and on Windows and macOS the tooltip is.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray_label(state: &std::sync::Arc<crate::server::State>, cfg_path: &std::path::Path) -> Option<String> {
    let raw = state.packets.lock().ok()?.get("obs_st")?.clone();
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let c = v.pointer("/obs/0/7")?.as_f64()?;
    let metric = crate::setting(cfg_path, "units").as_deref() == Some("metric");
    Some(if metric {
        format!("WeatherDesk — {c:.1} °C")
    } else {
        format!("WeatherDesk — {:.1} °F", c * 9.0 / 5.0 + 32.0)
    })
}

// Update checks go through our own commands rather than the plugin's JavaScript API: the
// frontend has no build step and no npm packages, so the only JS it can rely on is `invoke`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn updater_check(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    // Flatpak installs are updated by Flatpak; writing into /app would fail anyway.
    if std::path::Path::new("/.flatpak-info").exists() {
        return Ok(None);
    }
    // On Linux the updater plugin can only install an AppImage. A .deb (or anything else)
    // install has no $APPIMAGE, so be honest instead of offering an install that cannot work.
    #[cfg(target_os = "linux")]
    if std::env::var("APPIMAGE").is_err() {
        return Err("updates for this install come through your package manager (apt upgrade weather-desk), not the in-app updater".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    #[cfg(target_os = "linux")]
    if std::env::var("APPIMAGE").is_err() {
        return Err("updates for this install come through your package manager (apt upgrade weather-desk), not the in-app updater".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no update available")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![updater_check, updater_install]);
    }

    builder
        .setup(|app| {
            #[allow(unused_mut)]
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::default());

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let data_dir = app.path().app_data_dir().unwrap_or_else(|_| crate::default_data_dir());
                let cfg_path = app
                    .path()
                    .app_config_dir()
                    .map(|d| d.join("config.json"))
                    .unwrap_or_else(|_| crate::default_config_dir().join("config.json"));
                let (state, port) = crate::start_services(data_dir, cfg_path.clone());

                let show = MenuItem::with_id(app, "show", "Show WeatherDesk", true, None::<&str>)?;
                let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;
                let tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().cloned().unwrap())
                    .menu(&menu)
                    .tooltip("WeatherDesk")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "refresh" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.eval("location.reload()");
                            }
                        }
                        _ => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                let (tray_state, tray_cfg) = (state.clone(), cfg_path);
                std::thread::spawn(move || loop {
                    if let Some(label) = tray_label(&tray_state, &tray_cfg) {
                        let _ = tray.set_tooltip(Some(&label));
                        let _ = tray.set_title(Some(&label));
                    }
                    std::thread::sleep(std::time::Duration::from_secs(60));
                });

                // The window loads through Tauri's own asset protocol, not the LAN server: the
                // server's port moves when the configured one is taken, and WebKit keys
                // localStorage per origin, so a moving port would wipe the token and layout on
                // every restart.
                win = win
                    .title(format!("WeatherDesk — tablet: http://{}:{}", crate::server::lan_ip(), port))
                    .inner_size(1280.0, 800.0)
                    // Start maximized on Linux: KWin maximizes a restored window after mapping
                    // it, and GTK can miss that configure entirely — the webview then paints at
                    // the startup size in the corner of a full-screen window, with no way for
                    // the process to notice. Owning the state from the first frame sidesteps it.
                    .maximized(cfg!(target_os = "linux"))
                    // the window isn't same-origin with the LAN server, so it needs the port told to it
                    .initialization_script(format!(
                        "window.__WD_UDP='http://localhost:{port}/udp';window.__WD_SRV='http://localhost:{port}';{}",
                        crate::server::ver_script()
                    ));
            }

            win.build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running WeatherDesk");
}
