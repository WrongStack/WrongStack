fn main() {
    println!("cargo:rerun-if-env-changed=WRONGSTACK_DESKTOP_ENGINE_ID");
    let engine =
        std::env::var("WRONGSTACK_DESKTOP_ENGINE_ID").unwrap_or_else(|_| "development".into());
    assert!(
        engine == "development"
            || (engine.len() == 64
                && engine
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())),
        "Invalid desktop engine build identity"
    );
    println!("cargo:rustc-env=WRONGSTACK_DESKTOP_ENGINE_ID={engine}");
    #[cfg(feature = "desktop")]
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "host_request",
            "choose_project",
            "open_agent",
            "open_preview",
            "open_external",
            "terminal_stream",
            "open_project_window",
            "terminal_stop",
            "terminal_ack",
            "speech_status",
            "speech_start",
            "speech_stop",
        ]),
    ))
    .expect("Tauri build configuration");
}
