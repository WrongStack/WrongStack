#[cfg(feature = "desktop")]
pub mod desktop;
pub mod engine;
pub mod host;
pub mod http_bridge;
mod project_runtime;
pub mod registry;
mod request_pool;
pub mod sessions;
pub mod transcript;
pub mod window_geometry;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
