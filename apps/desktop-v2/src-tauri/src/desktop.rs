use crate::{err, host::Client, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

struct Desktop {
    client: Client,
    services: Client,
    drafts: Arc<Mutex<crate::registry::Registry>>,
    project_aliases: Arc<Mutex<HashMap<String, String>>>,
    streams: Mutex<HashMap<String, Arc<StreamControl>>>,
}
struct StreamControl {
    cancel: AtomicBool,
    ready: AtomicBool,
}
fn trusted(window: &WebviewWindow) -> Result<()> {
    if window.label() == "main" || window.label().starts_with("project-") {
        Ok(())
    } else {
        Err("This webview has no desktop capabilities".into())
    }
}
#[tauri::command]
async fn host_request(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    method: String,
    params: Value,
) -> Result<Value> {
    trusted(&window)?;
    // Endpoints contain access tokens and are consumed only inside the native boundary.
    if ![
        "snapshot",
        "project.register",
        "project.open",
        "project.status",
        "project.events",
        "project.send",
        "project.http",
        "profile.open",
        "profile.status",
        "profile.events",
        "profile.send",
        "profile.http",
        "session.open",
        "session.restore",
        "session.read",
        "session.write",
        "session.resize",
        "session.kill",
        "engine.send",
        "engine.http",
        "engine.events",
        "engine.identity",
        "settings.save",
        "draft.save",
        "draft.get",
        "draft.revisions",
        "draft.replace",
        "draft.object",
        "form-draft.get",
        "form-draft.save",
        "profile-draft.get",
        "profile-draft.save",
        "profile-draft.list",
        "file-drafts.list",
    ]
    .contains(&method.as_str())
    {
        return Err("Method unavailable to shell".into());
    }
    let client = state.client.clone();
    let services = state.services.clone();
    let drafts = Arc::clone(&state.drafts);
    let aliases = Arc::clone(&state.project_aliases);
    tauri::async_runtime::spawn_blocking(move || {
        if method == "profile-draft.get" || method == "profile-draft.save" {
            let registry = drafts.lock().map_err(err)?;
            let key = crate::sessions::field(&params, "formKey")?;
            if method == "profile-draft.get" { return registry.profile_form_draft(key); }
            let expected = params["expectedRevision"].as_i64().filter(|value| *value >= 0).ok_or("Missing profile draft revision")?;
            let value = params.get("value").ok_or("Missing profile draft value")?;
            return Ok(json!({"revision":registry.save_profile_form_draft(key, value, expected)?}));
        }
        if method == "profile-draft.list" {
            return drafts.lock().map_err(err)?.profile_form_drafts();
        }
        if method == "file-drafts.list" {
            return drafts.lock().map_err(err)?.file_drafts(crate::sessions::field(&params, "projectId")?);
        }
        if method == "session.restore" {
            if !crate::host::can_share_services(&client.call("ping", json!({}))?) {
                return Err("The running session host uses an older engine. Keep reading history, or stop its sessions and restart the desktop before resuming or forking.".into());
            }
            // A dedicated command fails closed on older hosts, unlike optional
            // session.open fields that an old binary could silently ignore.
            return client.call(&method, params);
        }
        if method == "form-draft.get" || method == "form-draft.save" {
            let registry = drafts.lock().map_err(err)?;
            let project_id = crate::sessions::field(&params, "projectId")?;
            let form_key = crate::sessions::field(&params, "formKey")?;
            if method == "form-draft.get" {
                return registry.form_draft(project_id, form_key);
            }
            let expected = params["expectedRevision"]
                .as_i64()
                .filter(|value| *value >= 0)
                .ok_or("Missing form draft revision")?;
            let value = params.get("value").ok_or("Missing form draft value")?;
            let revision = registry.save_form_draft(project_id, form_key, value, expected)?;
            return Ok(json!({"revision":revision}));
        }
        if method == "draft.object" {
            let registry = drafts.lock().map_err(err)?;
            return registry.draft_object(
                crate::sessions::field(&params, "id")?,
                params["part"].as_str().ok_or("Missing draft part")?,
            );
        }
        if method == "draft.get"
            || method == "draft.save"
            || method == "draft.revisions"
            || method == "draft.replace"
        {
            let registry = drafts.lock().map_err(err)?;
            let id = crate::sessions::field(&params, "id")?;
            if method == "draft.get" {
                return registry.draft_snapshot(id);
            }
            if method == "draft.revisions" {
                return registry.draft_revisions(id);
            }
            if method == "draft.replace" {
                return registry.replace_draft_checked(
                    id,
                    &params["draft"],
                    &params["expectedRevisions"],
                );
            }
            let text = params["text"].as_str().ok_or("Missing draft text")?;
            let expected = params["expectedRevision"]
                .as_i64()
                .filter(|value| *value >= 0)
                .ok_or("Missing draft revision")?;
            let revision = registry.save_draft_checked(
                id,
                params["part"].as_str().unwrap_or("text"),
                text,
                expected,
            )?;
            return Ok(json!({"revision":revision}));
        }
        if method.starts_with("profile.") {
            return services.call(&method, params);
        }
        if method.starts_with("project.") && method != "project.register" {
            let mut params = params;
            if client.endpoint.pid != services.endpoint.pid {
                let id = params["projectId"]
                    .as_str()
                    .ok_or("Missing project identity")?
                    .to_owned();
                let mut aliases = aliases.lock().map_err(err)?;
                let mapped = if let Some(mapped) = aliases.get(&id) {
                    mapped.clone()
                } else {
                    let snapshot = client.call("snapshot", json!({}))?;
                    let root = snapshot["projects"]
                        .as_array()
                        .and_then(|projects| projects.iter().find(|project| project["id"] == id))
                        .and_then(|project| project["root"].as_str())
                        .ok_or("Unknown project")?;
                    let registered = services.call("project.register", json!({"root":root}))?;
                    let mapped = registered["id"]
                        .as_str()
                        .ok_or("Missing registered project identity")?
                        .to_owned();
                    aliases.insert(id, mapped.clone());
                    mapped
                };
                params["projectId"] = json!(mapped);
            }
            return services.call(&method, params);
        }
        client.call(&method, params)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
async fn choose_project(window: WebviewWindow) -> Result<Option<String>> {
    trusted(&window)?;
    let folder = rfd::AsyncFileDialog::new()
        .set_title("Add a project to WrongStack")
        .pick_folder()
        .await;
    Ok(folder.map(|p| p.path().to_string_lossy().into_owned()))
}
#[tauri::command]
async fn open_preview(window: WebviewWindow, url: String) -> Result<()> {
    trusted(&window)?;
    let url: tauri::Url = url.parse().map_err(err)?;
    if !["http", "https"].contains(&url.scheme())
        || ![Some("localhost"), Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Preview URL must use HTTP(S) on localhost".into());
    }
    let child = WebviewWindowBuilder::new(
        window.app_handle(),
        format!("preview-{}", uuid::Uuid::new_v4()),
        WebviewUrl::External(url),
    )
    .title("WrongStack — Local Preview")
    .inner_size(1100., 800.)
    .build()
    .map_err(err)?;
    child.open_devtools();
    Ok(())
}
#[tauri::command]
async fn open_external(window: WebviewWindow, url: String) -> Result<()> {
    trusted(&window)?;
    let url: tauri::Url = url.parse().map_err(err)?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("External links must use HTTP(S) without credentials".into());
    }
    // A single URL argument, never a shell command; the privileged webview stays local.
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new(
        std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("Missing SystemRoot")?)
            .join("explorer.exe"),
    );
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    let mut child = command.arg(url.as_str()).spawn().map_err(err)?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
#[tauri::command]
async fn open_project_window(window: WebviewWindow, id: String) -> Result<()> {
    trusted(&window)?;
    uuid::Uuid::parse_str(&id).map_err(err)?;
    let label = format!("project-{id}");
    if let Some(existing) = window.app_handle().get_webview_window(&label) {
        return existing.set_focus().map_err(err);
    }
    WebviewWindowBuilder::new(
        window.app_handle(),
        label,
        WebviewUrl::App(format!("index.html?project={id}").into()),
    )
    .title("WrongStack — Project")
    .disable_drag_drop_handler()
    .inner_size(1360., 900.)
    .build()
    .map_err(err)?;
    Ok(())
}
#[tauri::command]
fn terminal_stream(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    id: String,
    subscription: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<()> {
    trusted(&window)?;
    uuid::Uuid::parse_str(&subscription).map_err(err)?;
    let cancel = Arc::new(StreamControl {
        cancel: AtomicBool::new(false),
        ready: AtomicBool::new(true),
    });
    let key = format!("{}:{subscription}", window.label());
    if let Some(previous) = state
        .streams
        .lock()
        .map_err(err)?
        .insert(key.clone(), Arc::clone(&cancel))
    {
        previous.cancel.store(true, Ordering::Relaxed);
    }
    let client = state.client.clone();
    let app = window.app_handle().clone();
    thread::spawn(move || {
        let mut offset: Option<u64> = None;
        while !cancel.cancel.load(Ordering::Relaxed) {
            if !cancel.ready.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(4));
                continue;
            }
            match client.call("session.read", json!({"id":id,"offset":offset})) {
                Ok(result) => {
                    let next = result["offset"].as_u64().unwrap_or(0);
                    let bytes = result["bytes"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|b| b.as_u64().map(|b| b as u8))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    offset = Some(next);
                    if !bytes.is_empty() {
                        cancel.ready.store(false, Ordering::Release);
                        if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                            break;
                        }
                    }
                    if next < result["end"].as_u64().unwrap_or(next) {
                        continue;
                    }
                }
                Err(_) => break,
            }
            thread::sleep(Duration::from_millis(16));
        }
        if let Some(state) = app.try_state::<Desktop>() {
            if let Ok(mut streams) = state.streams.lock() {
                if streams
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &cancel))
                {
                    streams.remove(&key);
                }
            }
        }
    });
    Ok(())
}
#[tauri::command]
fn terminal_stop(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    subscription: String,
) -> Result<()> {
    trusted(&window)?;
    if let Some(cancel) = state
        .streams
        .lock()
        .map_err(err)?
        .remove(&format!("{}:{subscription}", window.label()))
    {
        cancel.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
fn terminal_ack(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    subscription: String,
) -> Result<()> {
    trusted(&window)?;
    if let Some(stream) = state
        .streams
        .lock()
        .map_err(err)?
        .get(&format!("{}:{subscription}", window.label()))
    {
        stream.ready.store(true, Ordering::Release);
    }
    Ok(())
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let development = std::env::var_os("WRONGSTACK_DESKTOP_BUN").is_some()
                && std::env::var_os("WRONGSTACK_DESKTOP_ENTRY").is_some();
            let engine = if development || std::env::var_os("WRONGSTACK_DESKTOP_ENGINE").is_some() {
                None
            } else {
                let mut candidates = Vec::new();
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(parent) = exe.parent() {
                        candidates.push(parent.join("wrongstack-engine.exe"));
                    }
                }
                if let Ok(resources) = app.path().resource_dir() {
                    candidates.push(resources.join("wrongstack-engine.exe"));
                }
                candidates
                    .into_iter()
                    .find(|path| path.is_absolute() && path.is_file())
            };
            let client = Client::connect(engine.as_deref()).map_err(std::io::Error::other)?;
            let capabilities = client
                .call("ping", json!({}))
                .map_err(std::io::Error::other)?;
            let services = if crate::host::can_share_services(&capabilities)
                && std::env::var("WRONGSTACK_DESKTOP_USE_COMPANION_HOST").as_deref() != Ok("1")
            {
                client.clone()
            } else {
                // Keep old hosts and their live PTYs intact while adding project/profile services.
                Client::connect_at(
                    engine.as_deref(),
                    &crate::host::data_dir()
                        .map_err(std::io::Error::other)?
                        .join("project-services-v1")
                        .join(crate::host::engine_build()),
                )
                .map_err(std::io::Error::other)?
            };
            app.manage(Desktop {
                client,
                services,
                drafts: Arc::new(Mutex::new(
                    crate::registry::Registry::open(
                        &crate::host::data_dir().map_err(std::io::Error::other)?,
                    )
                    .map_err(std::io::Error::other)?,
                )),
                project_aliases: Arc::new(Mutex::new(HashMap::new())),
                streams: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<Desktop>() {
                    if let Ok(mut streams) = state.streams.lock() {
                        let prefix = format!("{}:", window.label());
                        streams.retain(|key, cancel| {
                            if key.starts_with(&prefix) {
                                cancel.cancel.store(true, Ordering::Relaxed);
                                false
                            } else {
                                true
                            }
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_request,
            choose_project,
            open_preview,
            open_external,
            open_project_window,
            terminal_stream,
            terminal_stop,
            terminal_ack
        ])
        .run(tauri::generate_context!())
        .expect("WrongStack desktop runtime");
}
