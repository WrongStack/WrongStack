//! Moving conversations onto this build's engine. The session host outlives the window and
//! every update, and it starts each engine from its own private copy: after an update the new
//! application keeps talking to a host, and engines, of the build that started it. Nothing
//! replaces that host on its own; the user does, from the notice the interface shows when the
//! host's engine build differs from the application's.
//!
//! The replacement stops every conversation gracefully through the old host, ends the host,
//! starts one of this build and reloads the windows. Stopped conversations resume through the
//! usual reconnect.

use crate::host::Client;
use crate::{err, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// How long conversations get to stop before the host is ended (engines take up to 12 s).
const STOP_GRACE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(250);

/// Whether a host whose `ping` answered `ping` runs another engine build than this application.
/// A host too old to report its build is another build. Development builds never are: their
/// identity is not a release.
pub fn host_is_stale(app_build: &str, ping: &Value) -> bool {
    if app_build == "development" {
        return false;
    }
    ping["engineBuild"].as_str() != Some(app_build)
}

/// The steps of a replacement, apart so their order can be tested without processes.
pub trait HostOps {
    type Connected;
    /// Conversations the host still runs or is stopping, as `(id, status)`.
    fn live(&self) -> Result<Vec<(String, String)>>;
    /// Asks the host to stop one conversation gracefully.
    fn stop(&self, id: &str) -> Result<()>;
    fn end_host(&self) -> Result<()>;
    /// Waits until no process holds the host's ownership lock.
    fn wait_released(&self) -> Result<()>;
    fn connect(&self) -> Result<Self::Connected>;
    fn sleep(&self, duration: Duration);
}

/// Stops the host's conversations, ends it and connects to a new one. Where ending the host
/// would not end its engines (Unix: each runs in its own process group), a conversation that
/// did not stop in time refuses the replacement, so no orphaned engine keeps writing to a
/// transcript a reconnect is about to resume.
pub fn replace_host<O: HostOps>(
    ops: &O,
    grace: Duration,
    poll: Duration,
    engines_outlive_host: bool,
) -> Result<O::Connected> {
    for (id, status) in ops.live()? {
        if status != "stopping" {
            // A conversation that refuses to stop is caught by the wait below.
            let _ = ops.stop(&id);
        }
    }
    let mut waited = Duration::ZERO;
    let mut remaining = ops.live()?;
    while !remaining.is_empty() && waited < grace {
        ops.sleep(poll);
        waited += poll;
        remaining = ops.live()?;
    }
    if !remaining.is_empty() && engines_outlive_host {
        let ids: Vec<_> = remaining.into_iter().map(|(id, _)| id).collect();
        return Err(format!(
            "These conversations did not stop, so the engine was not restarted: {}. Stop them and try again.",
            ids.join(", ")
        ));
    }
    ops.end_host()?;
    ops.wait_released()?;
    ops.connect()
}

struct RealHost<'a> {
    client: Client,
    dir: PathBuf,
    engine: Option<&'a Path>,
}

impl HostOps for RealHost<'_> {
    type Connected = Client;
    fn live(&self) -> Result<Vec<(String, String)>> {
        let snapshot = self.client.call("snapshot", json!({}))?;
        Ok(snapshot["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let status = s["status"].as_str()?;
                matches!(status, "running" | "starting" | "stopping").then(|| {
                    (
                        s["id"].as_str().unwrap_or_default().to_owned(),
                        status.to_owned(),
                    )
                })
            })
            .collect())
    }
    fn stop(&self, id: &str) -> Result<()> {
        self.client
            .call("session.kill", json!({"id": id}))
            .map(|_| ())
    }
    fn end_host(&self) -> Result<()> {
        let pid = self.client.endpoint.pid;
        #[cfg(windows)]
        {
            crate::windows_process::stop_tree(pid)
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .map_err(err)
                .map(|_| ())
        }
    }
    fn wait_released(&self) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.dir.join("owner.lock"))
                .map_err(err)?;
            // Released at once: the new host has to take this lock itself.
            if lock.try_lock().is_ok() {
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                return Err("The previous session host is still running".into());
            }
            std::thread::sleep(POLL);
        }
    }
    fn connect(&self) -> Result<Client> {
        Client::connect_at(self.engine, &self.dir)
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// This application's version and whether its session host runs another engine build.
#[tauri::command]
pub async fn host_info(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, crate::desktop::Desktop>,
) -> Result<Value> {
    crate::desktop::trusted(&window)?;
    let client = state.client();
    let ping = tauri::async_runtime::spawn_blocking(move || client.call("ping", json!({})))
        .await
        .map_err(err)??;
    Ok(json!({
        "appVersion": app.package_info().version.to_string(),
        "stale": host_is_stale(crate::host::engine_build(), &ping),
    }))
}

/// Replaces a session host of another build with one of this build, then reloads every
/// window: their streams and state belong to the old host.
#[tauri::command]
pub async fn host_restart(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, crate::desktop::Desktop>,
) -> Result<()> {
    crate::desktop::trusted(&window)?;
    if state.restarting.swap(true, Ordering::SeqCst) {
        return Err("The engine is already restarting".into());
    }
    let client = state.client();
    let engine = state.engine.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let ops = RealHost {
            client,
            dir: crate::host::data_dir()?,
            engine: engine.as_deref(),
        };
        replace_host(&ops, STOP_GRACE, POLL, cfg!(unix))
    })
    .await
    .map_err(err)
    .and_then(|r| r);
    let outcome = result.map(|client| state.replace_client(client));
    state.restarting.store(false, Ordering::SeqCst);
    outcome?;
    state.cancel_streams();
    for window in app.webview_windows().values() {
        if crate::desktop::trusted(window).is_ok() {
            let _ = window.eval("location.reload()");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn another_or_unreported_engine_build_is_stale_except_in_development() {
        let build = "a".repeat(64);
        assert!(!host_is_stale(&build, &json!({"engineBuild": build})));
        assert!(host_is_stale(
            &build,
            &json!({"engineBuild": "b".repeat(64)})
        ));
        assert!(host_is_stale(&build, &json!({"protocol": 1})));
        assert!(host_is_stale(&build, &json!({"engineBuild": 7})));
        assert!(!host_is_stale(
            "development",
            &json!({"engineBuild": "b".repeat(64)})
        ));
        assert!(!host_is_stale("development", &json!({})));
    }

    /// A host whose conversations stop after `stops_after` polls (never, when None).
    struct Fake {
        log: RefCell<Vec<String>>,
        polls: RefCell<u32>,
        stops_after: Option<u32>,
    }
    impl Fake {
        fn new(stops_after: Option<u32>) -> Self {
            Self {
                log: RefCell::new(Vec::new()),
                polls: RefCell::new(0),
                stops_after,
            }
        }
    }
    impl HostOps for Fake {
        type Connected = &'static str;
        fn live(&self) -> Result<Vec<(String, String)>> {
            let stopped = self.stops_after.is_some_and(|n| *self.polls.borrow() >= n);
            Ok(if stopped {
                vec![]
            } else {
                vec![
                    ("a".into(), "running".into()),
                    ("b".into(), "stopping".into()),
                ]
            })
        }
        fn stop(&self, id: &str) -> Result<()> {
            self.log.borrow_mut().push(format!("stop {id}"));
            Ok(())
        }
        fn end_host(&self) -> Result<()> {
            self.log.borrow_mut().push("end".into());
            Ok(())
        }
        fn wait_released(&self) -> Result<()> {
            self.log.borrow_mut().push("released".into());
            Ok(())
        }
        fn connect(&self) -> Result<&'static str> {
            self.log.borrow_mut().push("connect".into());
            Ok("new host")
        }
        fn sleep(&self, _: Duration) {
            *self.polls.borrow_mut() += 1;
        }
    }

    #[test]
    fn stops_conversations_then_ends_the_host_then_connects() {
        let fake = Fake::new(Some(3));
        let connected = replace_host(&fake, Duration::from_secs(1), POLL, true).unwrap();
        assert_eq!(connected, "new host");
        // Only the running conversation is asked to stop; one already stopping is waited for.
        assert_eq!(*fake.log.borrow(), ["stop a", "end", "released", "connect"]);
        assert_eq!(*fake.polls.borrow(), 3);
    }

    #[test]
    fn where_engines_outlive_the_host_a_conversation_that_will_not_stop_refuses() {
        let fake = Fake::new(None);
        let error = replace_host(&fake, Duration::from_secs(1), POLL, true).unwrap_err();
        assert!(error.contains("a, b"), "{error}");
        assert_eq!(*fake.log.borrow(), ["stop a"]);
    }

    #[test]
    fn where_ending_the_host_ends_its_tree_the_stragglers_go_with_it() {
        let fake = Fake::new(None);
        assert_eq!(
            replace_host(&fake, Duration::from_secs(1), POLL, false).unwrap(),
            "new host"
        );
        assert_eq!(*fake.log.borrow(), ["stop a", "end", "released", "connect"]);
    }
}
