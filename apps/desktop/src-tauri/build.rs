fn main() {
    // Declaring the app's own commands makes Tauri require a capability for
    // each one, like the plugin commands in capabilities/default.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "env_load",
            "env_save",
            "env_delete",
            "env_scan",
        ]),
    ))
    .expect("failed to run tauri-build");
}
