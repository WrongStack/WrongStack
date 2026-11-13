//! Project services have their own native lifecycle. They are never desktop sessions.
use crate::{engine::Engine, err, sessions::HostState, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub(crate) struct ProjectRuntime {
    runtime_id: String,
    status: String,
    error: Option<String>,
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
        if let Some(runtime) = runtimes.get(project_id) {
            if !retry || runtime.status == "starting" || runtime.status == "running" {
                return Ok(
                    json!({"projectId":project_id,"status":runtime.status,"error":runtime.error}),
                );
            }
        }
        let runtime_id = format!("project-{}", Uuid::new_v4());
        runtimes.insert(
            project_id.into(),
            ProjectRuntime {
                runtime_id: runtime_id.clone(),
                status: "starting".into(),
                error: None,
            },
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
        if let Some(runtime) = runtimes
            .values_mut()
            .find(|runtime| runtime.runtime_id == id)
        {
            runtime.status = status.into();
            runtime.error = error.map(str::to_owned);
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
            match self.project_runtimes.lock().map_err(err)?.get(project_id) {
                Some(runtime) => {
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
            .get(project_id)
            .map(|runtime| runtime.runtime_id.clone())
            .ok_or_else(|| "Project services have not started".into())
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
            ProjectRuntime {
                runtime_id: "project-contract".into(),
                status: "starting".into(),
                error: None,
            },
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
            ProjectRuntime {
                runtime_id: "project-rt-1".into(),
                status: "error".into(),
                error: Some("exited".into()),
            },
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
            ProjectRuntime {
                runtime_id: "project-rt-2".into(),
                status: "running".into(),
                error: None,
            },
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
}
