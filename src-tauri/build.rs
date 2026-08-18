fn main() {
    // Without the `gui` feature there is no Tauri in the tree to generate a context for — that
    // build is the headless/Docker binary.
    #[cfg(feature = "gui")]
    tauri_build::build()
}
