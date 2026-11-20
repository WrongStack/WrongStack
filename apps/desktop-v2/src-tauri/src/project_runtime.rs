//! Project services have their own native lifecycle. They are never desktop sessions.
use crate::{engine::Engine, err, sessions::HostState, Result};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Weak},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Project services no window asked for in this long are stopped, unless one of the project's
/// Kanban boards is supervised (its supervisor runs in them). The next visit starts them again.
pub(crate) const PROJECT_IDLE_STOP: Duration = Duration::from_secs(15 * 60);
const IDLE_SWEEP_EVERY: Duration = Duration::from_secs(60);

pub(crate) struct ProjectRuntime {
    runtime_id: String,
    status: String,
    error: Option<String>,
    /// The last time a window asked for these services: open, status, events, send or http.
    last_used: Instant,
    /// Stopped by the idle sweep: the entry goes once its engine exits, so the services read as
    /// never started and the next visit starts them.
    idle_stop: bool,
}
impl ProjectRuntime {
    fn new(runtime_id: String, status: &str, error: Option<String>) -> Self {
        Self {
            runtime_id,
            status: status.into(),
            error,
            last_used: Instant::now(),
            idle_stop: false,
        }
    }
    /// Running, not already being stopped, and untouched for `idle` at `now`.
    fn idle_at(&self, now: Instant, idle: Duration) -> bool {
        self.status == "running"
            && !self.idle_stop
            && now.saturating_duration_since(self.last_used) >= idle
    }
}
/// Runs the idle sweep once a minute for as long as the host lives.
pub(crate) fn start_idle_sweep(state: &Arc<HostState>) {
    let host: Weak<HostState> = Arc::downgrade(state);
    thread::spawn(move || loop {
        thread::sleep(IDLE_SWEEP_EVERY);
        let Some(host) = host.upgrade() else {
            return;
        };
        host.sweep_idle_project_runtimes(Instant::now(), PROJECT_IDLE_STOP);
    });
}
impl HostState {
    pub(crate) fn open_project_runtime(
        self: &Arc<Self>,
        project_id: &str,
        retry: bool,
    ) -> Result<Value> {
        let root = self
            .registry
            .lock()
            .map_err(err)?
            .workdir(project_id, None)?;
        self.open_runtime(project_id, &root.to_string_lossy(), retry)
    }
    pub(crate) fn open_profile_runtime(self: &Arc<Self>, retry: bool) -> Result<Value> {
        let root = self.dir.join("profile-context");
        std::fs::create_dir_all(&root).map_err(err)?;
        self.open_runtime("@profile", &root.to_string_lossy(), retry)
    }
    fn open_runtime(self: &Arc<Self>, project_id: &str, root: &str, retry: bool) -> Result<Value> {
        let mut runtimes = self.project_runtimes.lock().map_err(err)?;
        if let Some(runtime) = runtimes.get_mut(project_id) {
            runtime.last_used = Instant::now();
            if !retry || matches!(runtime.status.as_str(), "starting" | "running" | "stopping") {
                return Ok(
                    json!({"projectId":project_id,"status":runtime.status,"error":runtime.error}),
                );
            }
        }
        let runtime_id = format!("project-{}", Uuid::new_v4());
        runtimes.insert(
            project_id.into(),
            ProjectRuntime::new(runtime_id.clone(), "starting", None),
        );
        drop(runtimes);
        if let Err(error) = self.start_engine(&runtime_id, root, false) {
            self.publish_runtime_state(&runtime_id, "error", None, Some(&error))?;
        }
        self.runtime_status(project_id)
    }
    pub(crate) fn publish_runtime_state(
        &self,
        id: &str,
        status: &str,
        code: Option<i32>,
        error: Option<&str>,
    ) -> Result<()> {
        let mut runtimes = self.project_runtimes.lock().map_err(err)?;
        let project = runtimes
            .iter()
            .find(|(_, runtime)| runtime.runtime_id == id)
            .map(|(project, _)| project.clone());
        if let Some(project) = project {
            let runtime = runtimes
                .get_mut(&project)
                .ok_or("Project services vanished")?;
            if runtime.idle_stop && (status == "stopped" || status == "error") {
                runtimes.remove(&project);
            } else {
                runtime.status = status.into();
                runtime.error = error.map(str::to_owned);
            }
            return Ok(());
        }
        drop(runtimes);
        self.registry
            .lock()
            .map_err(err)?
            .state(id, status, code, error)
    }
    pub(crate) fn project_runtime_status(&self, project_id: &str) -> Result<Value> {
        self.registry
            .lock()
            .map_err(err)?
            .workdir(project_id, None)?;
        self.runtime_status(project_id)
    }
    pub(crate) fn runtime_status(&self, project_id: &str) -> Result<Value> {
        Ok(
            match self
                .project_runtimes
                .lock()
                .map_err(err)?
                .get_mut(project_id)
            {
                Some(runtime) => {
                    runtime.last_used = Instant::now();
                    json!({"projectId":project_id,"status":runtime.status,"error":runtime.error,"engineBuild":crate::host::engine_build()})
                }
                None => {
                    json!({"projectId":project_id,"status":"idle","error":null,"engineBuild":crate::host::engine_build()})
                }
            },
        )
    }
    fn project_runtime_id(&self, project_id: &str) -> Result<String> {
        self.project_runtimes
            .lock()
            .map_err(err)?
            .get_mut(project_id)
            .map(|runtime| {
                runtime.last_used = Instant::now();
                runtime.runtime_id.clone()
            })
            .ok_or_else(|| "Project services have not started".into())
    }
    /// Stops, gracefully, the project services nobody used for `idle` at `now` and that host no
    /// supervised Kanban board. Returns the projects whose services were asked to stop.
    pub(crate) fn sweep_idle_project_runtimes(
        self: &Arc<Self>,
        now: Instant,
        idle: Duration,
    ) -> Vec<String> {
        self.sweep_idle_project_runtimes_with_stop(now, idle, |id| self.stop(id))
    }

    fn sweep_idle_project_runtimes_with_stop(
        &self,
        now: Instant,
        idle: Duration,
        stop: impl Fn(&str) -> Result<Value>,
    ) -> Vec<String> {
        let candidates: Vec<(String, String)> = match self.project_runtimes.lock() {
            Ok(runtimes) => runtimes
                .iter()
                .filter(|(_, runtime)| runtime.idle_at(now, idle))
                .map(|(project, runtime)| (project.clone(), runtime.runtime_id.clone()))
                .collect(),
            Err(_) => return Vec::new(),
        };
        let mut stopped = Vec::new();
        for (project, runtime_id) in candidates {
            let engine = self.live.lock().ok().and_then(|live| {
                live.get(&runtime_id)
                    .and_then(|session| session.engine.clone())
            });
            // Without its connection the host cannot see the boards' supervision: keep it.
            if engine.is_none_or(|engine| engine.supervises_kanban()) {
                continue;
            }
            {
                let Ok(mut runtimes) = self.project_runtimes.lock() else {
                    continue;
                };
                // Used again, or replaced, since the candidates were read.
                match runtimes.get_mut(&project) {
                    Some(runtime)
                        if runtime.runtime_id == runtime_id && runtime.idle_at(now, idle) =>
                    {
                        runtime.idle_stop = true;
                        runtime.status = "stopping".into();
                    }
                    _ => continue,
                }
            }
            if stop(&runtime_id).is_ok() {
                stopped.push(project);
                continue;
            }
            // Match stop's lock order and keep the ownership check and state change together.
            let (Ok(live), Ok(mut runtimes)) = (self.live.lock(), self.project_runtimes.lock())
            else {
                continue;
            };
            let Some(runtime) = runtimes
                .get_mut(&project)
                .filter(|runtime| runtime.runtime_id == runtime_id)
            else {
                continue;
            };
            match live.get(&runtime_id) {
                Some(session) if !session.stop_requested => {
                    // A failed stop may leave the engine running. Let the next sweep try again.
                    runtime.idle_stop = false;
                    runtime.status = "running".into();
                }
                Some(_) => {} // Another request has already started shutdown.
                None => {
                    runtimes.remove(&project);
                }
            }
        }
        stopped
    }
    fn project_engine(&self, project_id: &str) -> Result<Arc<Engine>> {
        let id = self.project_runtime_id(project_id)?;
        self.live
            .lock()
            .map_err(err)?
            .get(&id)
            .and_then(|live| live.engine.clone())
            .ok_or_else(|| "Project services are starting".into())
    }
    /// A page of the project's journal from `offset`. A first read (`offset` 0) that asks for
    /// `recent` bytes reads only them, led by the journal's seed frames
    /// ([`Engine::recent_events`]).
    pub(crate) fn project_events(
        &self,
        project_id: &str,
        offset: u64,
        recent: Option<u64>,
        expected_runtime_id: Option<&str>,
    ) -> Result<Value> {
        let id = self.project_runtime_id(project_id)?;
        let path = self
            .dir
            .join("transcripts")
            .join(format!("{id}.events.jsonl"));
        let size = std::fs::metadata(&path).map_or(0, |meta| meta.len());
        let rotated = expected_runtime_id.is_some_and(|prev| prev != id) || offset > size;
        let effective_offset = if rotated { 0 } else { offset };
        let mut page = match (rotated, recent) {
            (true, _) => Engine::recent_events(&path, recent.unwrap_or(32 * 1024 * 1024))?,
            (false, Some(window)) if effective_offset == 0 => Engine::recent_events(&path, window)?,
            _ => Engine::events(&path, effective_offset)?,
        };
        page["runtimeId"] = json!(id);
        Ok(page)
    }
    pub(crate) fn project_journal_end(&self, project_id: &str) -> Result<Value> {
        let id = self.project_runtime_id(project_id)?;
        Engine::journal_end(
            &self
                .dir
                .join("transcripts")
                .join(format!("{id}.events.jsonl")),
        )
    }
    pub(crate) fn project_send(&self, project_id: &str, message: Value) -> Result<Value> {
        let kind = message["type"]
            .as_str()
            .ok_or("Missing project operation")?;
        if project_id == "@profile"
            && [
                "kanban.",
                "agent-roster.",
                "memory.",
                "files.",
                "git.",
                "worktree.",
                "goal.",
                "goal-state.",
                "sdd.",
            ]
            .iter()
            .any(|prefix| kind.starts_with(prefix))
        {
            return Err("Project operations require a project workspace".into());
        }
        if project_id != "@profile"
            && (kind == "prefs.update"
                || kind == "model.switch"
                || kind.starts_with("key.")
                || [
                    "provider.add",
                    "provider.update",
                    "provider.remove",
                    "provider.custom_models.set",
                    "provider.custom_models.remove",
                ]
                .contains(&kind))
        {
            return Err("Profile configuration belongs to WrongStack settings".into());
        }
        let project_history = project_id != "@profile"
            && matches!(kind, "sessions.list" | "session.inspect" | "session.rename");
        if !project_history
            && (matches!(
                kind,
                "user_message" | "abort" | "user.input_submit" | "tool.confirm_result"
            ) || kind.starts_with("session.")
                || kind.starts_with("sessions."))
        {
            return Err("Conversation operations belong to an agent session".into());
        }
        self.project_engine(project_id)?.send(message)
    }
    pub(crate) fn project_http(&self, project_id: &str, params: &Value) -> Result<Value> {
        self.project_engine(project_id)?.http(
            params["method"].as_str().ok_or("Missing method")?,
            params["resource"].as_str().ok_or("Missing resource")?,
            &params["body"],
            params["operationId"].as_str(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_services_are_not_conversation_sessions_and_reject_unknown_projects() {
        let dir = std::env::temp_dir().join(format!("desktop-project-contract-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.join("repo").to_str().unwrap())
            .unwrap();
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["status"],
            "idle"
        );
        assert!(host.project_runtime_status("unknown").is_err());
        host.project_runtimes.lock().unwrap().insert(
            project.id.clone(),
            ProjectRuntime::new("project-contract".into(), "starting", None),
        );
        host.publish_runtime_state(
            "project-contract",
            "error",
            Some(1),
            Some("Service unavailable"),
        )
        .unwrap();
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["error"],
            "Service unavailable"
        );
        for kind in ["user_message", "abort", "session.new", "user.input_submit"] {
            assert!(host
                .project_send(&project.id, json!({"type":kind}))
                .unwrap_err()
                .contains("agent session"));
        }
        for kind in ["sessions.list", "session.inspect", "session.rename"] {
            assert!(host
                .project_send(&project.id, json!({"type":kind}))
                .unwrap_err()
                .contains("Project services are starting"));
            assert!(host
                .project_send("@profile", json!({"type":kind}))
                .unwrap_err()
                .contains("agent session"));
        }
        for kind in [
            "session.resume",
            "session.rewind",
            "session.delete",
            "session.subscribe",
        ] {
            assert!(host
                .project_send(&project.id, json!({"type":kind}))
                .unwrap_err()
                .contains("agent session"));
        }
        assert!(host
            .project_send(&project.id, json!({"type":"prefs.update"}))
            .unwrap_err()
            .contains("WrongStack settings"));
        assert!(host
            .project_send("@profile", json!({"type":"kanban.create"}))
            .unwrap_err()
            .contains("project workspace"));
        assert!(host
            .project_send("@profile", json!({"type":"agent-roster.create"}))
            .unwrap_err()
            .contains("project workspace"));
        assert!(host.registry.lock().unwrap().sessions().unwrap().is_empty());
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn project_events_reports_runtime_id_and_rewinds_on_rotation_or_truncation() {
        let dir = std::env::temp_dir().join(format!("desktop-project-events-{}", Uuid::new_v4()));
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(&work.to_string_lossy())
            .unwrap();
        let transcripts = dir.join("transcripts");
        let old_line = format!(
            "{}\n",
            json!({"type":"session.start","payload":{"sessionId":"s-old"}})
        );
        std::fs::write(
            transcripts.join("project-rt-1.events.jsonl"),
            old_line.repeat(4),
        )
        .unwrap();
        host.project_runtimes.lock().unwrap().insert(
            project.id.clone(),
            ProjectRuntime::new("project-rt-1".into(), "error", Some("exited".into())),
        );
        let page1 = host
            .request(
                "project.events",
                &json!({"projectId": project.id, "offset": 0, "recent": 32_000_000}),
            )
            .unwrap();
        let offset1 = page1["offset"].as_u64().unwrap();
        assert_eq!(page1["runtimeId"], "project-rt-1");

        // Rotate to project-rt-2 with a journal larger than offset1: runtimeId mismatch still rewinds.
        let new_line = format!(
            "{}\n",
            json!({"type":"session.start","payload":{"sessionId":"s-new"}})
        );
        std::fs::write(
            transcripts.join("project-rt-2.events.jsonl"),
            new_line.repeat(6),
        )
        .unwrap();
        host.project_runtimes.lock().unwrap().insert(
            project.id.clone(),
            ProjectRuntime::new("project-rt-2".into(), "running", None),
        );
        let page2 = host
            .request(
                "project.events",
                &json!({"projectId": project.id, "offset": offset1, "runtimeId": "project-rt-1"}),
            )
            .unwrap();
        assert_eq!(page2["runtimeId"], "project-rt-2");
        assert_eq!(page2["events"].as_array().unwrap().len(), 6);
        let offset2 = page2["offset"].as_u64().unwrap();

        // Truncated/smaller replacement without runtimeId also rewinds when offset > size.
        std::fs::write(transcripts.join("project-rt-2.events.jsonl"), &new_line).unwrap();
        let page3 = host
            .request(
                "project.events",
                &json!({"projectId": project.id, "offset": offset2}),
            )
            .unwrap();
        assert_eq!(page3["events"].as_array().unwrap().len(), 1);
        assert_eq!(page3["events"][0]["payload"]["sessionId"], "s-new");

        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_running_services_untouched_for_the_idle_window_are_idle() {
        let mut runtime = ProjectRuntime::new("project-idle".into(), "running", None);
        let idle = Duration::from_secs(900);
        let later = runtime.last_used + idle;
        assert!(!runtime.idle_at(later - Duration::from_secs(1), idle));
        assert!(runtime.idle_at(later, idle));
        runtime.status = "starting".into();
        assert!(!runtime.idle_at(later, idle));
        runtime.status = "running".into();
        runtime.idle_stop = true;
        assert!(!runtime.idle_at(later, idle), "already being stopped");
        runtime.idle_stop = false;
        runtime.last_used = later;
        assert!(!runtime.idle_at(later, idle), "used again");
    }

    #[test]
    fn deleting_the_last_supervised_board_allows_an_idle_engine_to_stop() {
        use crate::sessions::LiveSession;
        use std::{net::TcpListener, sync::mpsc};
        use tungstenite::Message;

        let dir = std::env::temp_dir().join(format!("desktop-project-cleanup-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let runtime_id = "project-cleanup";
        let (send, frames) = mpsc::channel::<(String, Vec<Value>)>();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            while let Ok((marker, messages)) = frames.recv() {
                for message in messages {
                    socket
                        .send(Message::Text(message.to_string().into()))
                        .unwrap();
                }
                let ready = json!({"type":"session.start","payload":{"sessionId":marker}});
                socket
                    .send(Message::Text(ready.to_string().into()))
                    .unwrap();
            }
            socket.close(None).unwrap();
        });
        let engine = Engine::connect(
            port,
            "fixture",
            &dir.join("transcripts").join("project-cleanup.events.jsonl"),
            false,
        )
        .unwrap();
        host.live.lock().unwrap().insert(
            runtime_id.into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                // The fixture acknowledges the stop file by clearing this entry.
                agent_pid: Some(u32::MAX),
                engine: Some(Arc::clone(&engine)),
                stop_requested: false,
            },
        );
        host.project_runtimes.lock().unwrap().insert(
            "project".into(),
            ProjectRuntime::new(runtime_id.into(), "running", None),
        );
        let idle = PROJECT_IDLE_STOP;
        let now = Instant::now() + idle;
        let status = |board| json!({"type":"kanban.supervisor.status","payload":{"success":true,"data":{"boardId":board,"status":"healthy"}}});
        let deletion = |board, removed| json!({"type":"kanban.delete","payload":{"success":true,"data":{"boardId":board,"removed":removed}}});
        let empty_mirror = json!({"type":"kanban.supervisor.status","payload":{"success":true,
            "data":{"boardId":"boot-mirror","status":"healthy","emptySessionMirror":true}}});
        let publish = |marker: &str, messages| {
            send.send((marker.into(), messages)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            // The reader processes each notification before it publishes the marker.
            while engine.identity()["sessionId"] != marker {
                assert!(Instant::now() < deadline, "engine missed marker {marker}");
                thread::yield_now();
            }
        };
        let sweep_after = |marker: &str, messages| {
            publish(marker, messages);
            host.sweep_idle_project_runtimes(now, idle)
        };
        let before_delete = sweep_after("supervised", vec![status("a"), status("b"), empty_mirror]);
        let after_one = sweep_after("one-removed", vec![deletion("a", true)]);
        let after_failed = sweep_after("failed-removal", vec![deletion("b", false)]);
        publish("last-removed", vec![deletion("b", true)]);
        let failed_stop = host.sweep_idle_project_runtimes_with_stop(now, idle, |id| {
            assert_eq!(id, runtime_id);
            assert_eq!(
                host.runtime_status("project").unwrap()["status"],
                "stopping"
            );
            Err("Fixture could not stop the engine".into())
        });
        let status_after_failed_stop = host.runtime_status("project").unwrap()["status"].clone();
        let after_last = host.sweep_idle_project_runtimes(Instant::now() + idle, idle);
        let asked_to_stop = dir
            .join("transcripts")
            .join("project-cleanup.stop")
            .exists();
        // Keep the connected engine in its stop grace period until the retry has returned.
        std::fs::write(dir.join("frontend-disabled"), b"fixture").unwrap();
        let retry_during_stop = host
            .open_runtime("project", dir.to_str().unwrap(), true)
            .unwrap();
        let mut session = host.live.lock().unwrap().remove(runtime_id).unwrap();
        host.publish_runtime_state(runtime_id, "stopped", Some(0), None)
            .unwrap();
        let final_status = host.runtime_status("project").unwrap()["status"].clone();

        let stopped_by_another_request = "project-stopped-by-another-request";
        session.stop_requested = false;
        host.live
            .lock()
            .unwrap()
            .insert(stopped_by_another_request.into(), session);
        host.project_runtimes.lock().unwrap().insert(
            "project".into(),
            ProjectRuntime::new(stopped_by_another_request.into(), "running", None),
        );
        host.sweep_idle_project_runtimes_with_stop(Instant::now() + idle, idle, |id| {
            assert_eq!(id, stopped_by_another_request);
            // Another request succeeds while the first stop's failure is still in flight.
            host.stop(id).unwrap();
            Err("Fixture earlier stop request failed".into())
        });
        let status_after_other_stop = host.runtime_status("project").unwrap()["status"].clone();
        let session = host
            .live
            .lock()
            .unwrap()
            .remove(stopped_by_another_request)
            .unwrap();
        host.publish_runtime_state(stopped_by_another_request, "stopped", Some(0), None)
            .unwrap();

        let exited_id = "project-exited-during-stop";
        host.live.lock().unwrap().insert(exited_id.into(), session);
        host.project_runtimes.lock().unwrap().insert(
            "project".into(),
            ProjectRuntime::new(exited_id.into(), "running", None),
        );
        let raced_stop =
            host.sweep_idle_project_runtimes_with_stop(Instant::now() + idle, idle, |id| {
                assert_eq!(id, exited_id);
                // The exit watcher removes the live entry before publishing the terminal state.
                host.live.lock().unwrap().remove(id).unwrap();
                Err("Fixture engine already exited".into())
            });
        let status_after_exit_race = host.runtime_status("project").unwrap()["status"].clone();
        drop(send);
        server.join().unwrap();
        drop(host);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            before_delete.is_empty(),
            "a supervised engine stays running"
        );
        assert!(after_one.is_empty(), "a remaining board keeps it running");
        assert!(
            after_failed.is_empty(),
            "an unsuccessful deletion changes nothing"
        );
        assert_eq!(
            status_after_failed_stop, "running",
            "a connected engine remains owned after its stop request fails"
        );
        assert!(
            failed_stop.is_empty(),
            "the failed stop must be tried again"
        );
        assert_eq!(
            after_last,
            ["project"],
            "a deleted board and the empty boot mirror cannot keep the engine running"
        );
        assert!(asked_to_stop);
        assert_eq!(retry_during_stop["status"], "stopping");
        assert_eq!(final_status, "idle");
        assert_eq!(status_after_other_stop, "stopping");
        assert!(raced_stop.is_empty());
        assert_eq!(status_after_exit_race, "idle");
    }

    #[test]
    fn retry_waits_for_idle_stop_to_release_the_project_runtime() {
        let dir = std::env::temp_dir().join(format!("desktop-project-retry-{}", Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(repo.to_str().unwrap())
            .unwrap();
        // An accidental start must not launch a process during the shutdown fixture.
        std::fs::write(dir.join("frontend-disabled"), b"fixture").unwrap();
        let previous = "project-still-stopping";
        let mut stopping = ProjectRuntime::new(previous.into(), "stopping", None);
        stopping.idle_stop = true;
        host.project_runtimes
            .lock()
            .unwrap()
            .insert(project.id.clone(), stopping);

        let open = |retry| {
            host.request(
                "project.open",
                &json!({"projectId":project.id,"retry":retry}),
            )
            .unwrap()["status"]
                .clone()
        };
        let normal_open = open(false);
        // Hold the exit publication until both open requests have returned.
        let retry_open = open(true);
        let retained = host.project_runtimes.lock().unwrap()[&project.id]
            .runtime_id
            .clone();
        host.publish_runtime_state(previous, "stopped", Some(0), None)
            .unwrap();
        let after_exit = host.project_runtime_status(&project.id).unwrap()["status"].clone();
        let after_retry = if after_exit == "idle" {
            Some(open(true))
        } else {
            None
        };
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();

        assert_eq!(normal_open, "stopping", "ordinary opens already wait");
        assert_eq!(
            retry_open, "stopping",
            "a retry must not start another engine before the shutdown finishes"
        );
        assert_eq!(retained, previous);
        assert_eq!(after_exit, "idle");
        assert_eq!(
            after_retry.unwrap(),
            "error",
            "a new start is attempted after exit"
        );
    }

    #[test]
    fn the_sweep_keeps_services_it_cannot_see_and_an_idle_stop_reads_as_never_started() {
        let dir = std::env::temp_dir().join(format!("desktop-project-idle-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.join("repo").to_str().unwrap())
            .unwrap();
        host.project_runtimes.lock().unwrap().insert(
            project.id.clone(),
            ProjectRuntime::new("project-idle".into(), "running", None),
        );
        let idle = Duration::from_secs(900);
        // No engine connection: the boards' supervision is unknown, so nothing is stopped.
        let later = Instant::now() + idle;
        assert!(host.sweep_idle_project_runtimes(later, idle).is_empty());
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["status"],
            "running"
        );
        // A status read is a use: the services are no longer idle at that moment.
        let last_used = host.project_runtimes.lock().unwrap()[&project.id].last_used;
        assert!(last_used + idle > later);

        // Once an idle-stopped engine exits, its entry goes and the services read as idle.
        host.project_runtimes
            .lock()
            .unwrap()
            .get_mut(&project.id)
            .unwrap()
            .idle_stop = true;
        host.publish_runtime_state("project-idle", "stopping", None, None)
            .unwrap();
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["status"],
            "stopping"
        );
        host.publish_runtime_state("project-idle", "stopped", Some(0), None)
            .unwrap();
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["status"],
            "idle"
        );
        // A crash of services nobody stopped stays visible.
        host.project_runtimes.lock().unwrap().insert(
            project.id.clone(),
            ProjectRuntime::new("project-crash".into(), "running", None),
        );
        host.publish_runtime_state("project-crash", "error", Some(1), Some("exited"))
            .unwrap();
        assert_eq!(
            host.project_runtime_status(&project.id).unwrap()["status"],
            "error"
        );
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
