#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point only. Everything lives in `lib.rs`, which the Android build links directly.
fn main() {
    weatherdesk_lib::run();
}
