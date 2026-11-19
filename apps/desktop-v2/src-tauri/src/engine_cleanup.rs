//! Native-only engine process inspection. Never route termination through the engine itself.
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanEngine {
    pub pid: u32,
    pub identity: String,
    pub image: String,
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn scan_orphan_engines() -> crate::Result<Option<Vec<OrphanEngine>>> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| {
        crate::windows_process::scan_orphan_engines(&crate::host::data_dir()?).map(Some)
    })
    .await
    .map_err(crate::err)?;
    #[cfg(not(windows))]
    Ok(None)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn stop_orphan_engine(target: OrphanEngine) -> crate::Result<()> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        crate::windows_process::stop_orphan_engine(&crate::host::data_dir()?, &target)
    })
    .await
    .map_err(crate::err)?;
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("Engine cleanup is not available on this platform.".into())
    }
}
