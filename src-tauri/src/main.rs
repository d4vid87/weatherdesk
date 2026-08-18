#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point only. Everything lives in `lib.rs`, which the Android build links directly.
// `--headless` is the same process without a window — a LAN dashboard on a box with no desktop,
// which is also all the Docker image is.
fn main() {
    if std::env::args().any(|a| a == "--headless") {
        return weatherdesk_lib::run_headless();
    }
    #[cfg(feature = "gui")]
    weatherdesk_lib::run();
    #[cfg(not(feature = "gui"))]
    weatherdesk_lib::run_headless();
}
