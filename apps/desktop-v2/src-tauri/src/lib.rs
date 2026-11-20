#[cfg(feature = "desktop")]
pub mod desktop;
pub mod engine;
#[cfg(any(feature = "desktop", all(windows, test)))]
mod engine_cleanup;
pub mod host;
#[cfg(feature = "desktop")]
mod host_restart;
pub mod http_bridge;
#[cfg(any(feature = "desktop", test))]
mod project_menu;
mod project_runtime;
pub mod registry;
mod request_pool;
pub mod sessions;
mod shell_dir;
#[cfg(feature = "desktop")]
mod speech;
pub mod transcript;
#[cfg(feature = "desktop")]
mod update;
pub mod window_geometry;
#[cfg(windows)]
mod windows_process;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
/// With the desktop feature, the updater builds reqwest with rustls but no crypto provider, and
/// building any client without one panics. Every client is built after this.
pub fn ensure_tls_provider() {
    #[cfg(feature = "desktop")]
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
