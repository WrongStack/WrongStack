//! Desktop updates. Windows (NSIS) and macOS (.app) install a signed release in place through
//! the Tauri updater once a public key is configured (`plugins.updater.pubkey`); until then,
//! and on Linux, whose deb/rpm packages cannot replace themselves, the check reads the latest
//! GitHub release and the interface links to its page.
//!
//! Installing restarts only the application: the session host and its conversations outlive
//! the window and keep running through the update.

use crate::{err, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES_PAGE: &str = "https://github.com/WrongStack/WrongStack/releases/latest";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/WrongStack/WrongStack/releases/latest";
/// How long a check answers every window before the network is asked again.
const CHECK_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    /// The newer version, when there is one.
    pub version: Option<String>,
    /// Where the release is described and can be downloaded.
    pub release_url: String,
    /// Whether this build can download and install the release itself.
    pub can_install: bool,
}

#[derive(Default)]
pub struct UpdateState {
    checked: Mutex<Option<(Instant, UpdateStatus)>>,
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

/// `candidate` (a release tag such as `v1.7.1`) is a stable release newer than `current`.
/// Pre-releases (`1.8.0-rc.1`) and anything that is not `major.minor.patch` never are.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn parse(v: &str) -> Option<(u64, u64, u64)> {
        let v = v.trim().trim_start_matches('v');
        let mut parts = v.split('.');
        let parsed = (
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        );
        parts.next().is_none().then_some(parsed)
    }
    match (parse(candidate), parse(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => false,
    }
}

/// Whether this build installs updates itself: a released build on Windows or macOS with a
/// configured public key.
fn installs_itself(app: &AppHandle) -> bool {
    cfg!(any(windows, target_os = "macos"))
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u["pubkey"].as_str())
            .is_some_and(|key| !key.trim().is_empty())
}

/// The HTTPS client for the release check. The updater installs a TLS crypto provider only when
/// it checks, which the fallback path never does.
fn release_client() -> Option<reqwest::blocking::Client> {
    crate::ensure_tls_provider();
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("WrongStack-Desktop")
        .build()
        .ok()
}

/// The latest release on GitHub, as `(tag, page)`. Rate limits and network errors read as
/// "nothing newer": an update notice is never worth an error.
fn latest_release() -> Option<(String, String)> {
    let client = release_client()?;
    let response = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().ok()?;
    let tag = body["tag_name"].as_str()?.to_owned();
    let page = body["html_url"]
        .as_str()
        .filter(|url| url.starts_with("https://github.com/"))
        .unwrap_or(RELEASES_PAGE)
        .to_owned();
    Some((tag, page))
}

async fn check_now(app: &AppHandle, state: &UpdateState) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    let mut status = UpdateStatus {
        current: current.clone(),
        release_url: RELEASES_PAGE.into(),
        ..Default::default()
    };
    if installs_itself(app) {
        if let Ok(Some(update)) = async {
            // Bounded: the check holds the cache every window waits on.
            app.updater_builder()
                .timeout(Duration::from_secs(20))
                .build()?
                .check()
                .await
        }
        .await
        {
            status.version = Some(update.version.clone());
            status.can_install = true;
            *state.pending.lock().await = Some(update);
            return status;
        }
        *state.pending.lock().await = None;
    }
    let found = tauri::async_runtime::spawn_blocking(latest_release)
        .await
        .ok()
        .flatten();
    if let Some((tag, page)) = found {
        if is_newer(&tag, &current) {
            status.version = Some(tag.trim_start_matches('v').to_owned());
            status.release_url = page;
        }
    }
    status
}

/// The newest release this build could move to. Every window asks; the network is asked at
/// most once per [`CHECK_TTL`] unless `force` is set. Development builds never offer one.
#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    app: AppHandle,
    force: Option<bool>,
) -> Result<UpdateStatus> {
    crate::desktop::trusted(&window)?;
    let state = app.state::<UpdateState>();
    if crate::host::engine_build() == "development" {
        return Ok(UpdateStatus {
            current: app.package_info().version.to_string(),
            release_url: RELEASES_PAGE.into(),
            ..Default::default()
        });
    }
    let mut checked = state.checked.lock().await;
    if force != Some(true) {
        if let Some((at, status)) = checked.as_ref() {
            if at.elapsed() < CHECK_TTL {
                return Ok(status.clone());
            }
        }
    }
    let status = check_now(&app, &state).await;
    *checked = Some((Instant::now(), status.clone()));
    Ok(status)
}

/// Downloads, verifies and installs the update the last check found, then restarts the
/// application. One install at a time; a second request while one runs is refused.
#[tauri::command]
pub async fn update_install(window: WebviewWindow, app: AppHandle) -> Result<()> {
    crate::desktop::trusted(&window)?;
    let state = app.state::<UpdateState>();
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed".into());
    }
    let result = async {
        let update = state
            .pending
            .lock()
            .await
            .take()
            .ok_or("No update is ready to install; check again")?;
        // Windows hands over to the installer and exits from inside this call: save what the
        // window would save on close first.
        crate::desktop::persist_geometry(&app);
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(err)
    }
    .await;
    state.installing.store(false, Ordering::SeqCst);
    result?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_newer_stable_release_counts() {
        assert!(is_newer("v1.7.1", "1.7.0"));
        assert!(is_newer("1.8.0", "1.7.9"));
        assert!(is_newer("v2.0.0", "1.99.99"));
        assert!(!is_newer("v1.7.0", "1.7.0"));
        assert!(!is_newer("v1.6.3", "1.7.0"));
        assert!(!is_newer("v1.8.0-rc.1", "1.7.0"));
        assert!(!is_newer("1.8", "1.7.0"));
        assert!(!is_newer("latest", "1.7.0"));
        assert!(!is_newer("v1.8.0", "dev"));
    }

    /// Without a TLS provider the fallback check could never reach GitHub, and would say so
    /// to nobody: a failed check reads as "nothing newer".
    #[test]
    fn the_release_check_has_an_https_client() {
        assert!(release_client().is_some());
    }

    /// A `plugins.updater` block the plugin cannot read fails the application at startup.
    #[test]
    fn the_updater_configuration_is_one_the_plugin_accepts() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = config["plugins"]["updater"].clone();
        assert!(updater.is_object(), "tauri.conf.json needs plugins.updater");
        let parsed: tauri_plugin_updater::Config = serde_json::from_value(updater).unwrap();
        assert_eq!(
            parsed
                .endpoints
                .iter()
                .map(|u| u.as_str())
                .collect::<Vec<_>>(),
            ["https://github.com/WrongStack/WrongStack/releases/latest/download/latest.json"]
        );
    }
}
