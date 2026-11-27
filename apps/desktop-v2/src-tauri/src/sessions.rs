use crate::engine::Engine;
use crate::transcript::{CursorHandshake, Transcript};
use crate::{
    err, now,
    registry::{Registry, Session},
    Result,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use uuid::Uuid;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
/// When a spare was claimed (none while it waits); a claimed start has the usual deadline.
type ClaimTime = Arc<Mutex<Option<std::time::Instant>>>;

pub struct LiveSession {
    pub master: Option<Box<dyn MasterPty + Send>>,
    pub writer: Option<SharedWriter>,
    pub killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    pub agent_pid: Option<u32>,
    pub engine: Option<Arc<Engine>>,
    pub(crate) stop_requested: bool,
}
pub struct HostState {
    pub(crate) project_runtimes: Mutex<HashMap<String, crate::project_runtime::ProjectRuntime>>,
    pub registry: Mutex<Registry>,
    pub live: Mutex<HashMap<String, LiveSession>>,
    session_changes: Mutex<HashMap<String, SessionChange>>,
    pub dir: PathBuf,
    /// The engine a later launch handed over when this host was started without one.
    adopted_engine: Mutex<Option<PathBuf>>,
    /// Booted engines waiting to become a conversation, newest last.
    spares: Mutex<Vec<SpareEngine>>,
    /// Conversations whose running engine was started under another runtime id (a spare taken
    /// over by a reconnect): conversation id -> the engine's runtime id, whose stop file the
    /// engine watches.
    aliases: Mutex<HashMap<String, String>>,
    /// Working directories a spare is being started for right now, so a second request does
    /// not start another while the first one's process is still being created.
    warming: Mutex<std::collections::HashSet<String>>,
}

enum SessionChange {
    Opening { stop_when_started: bool },
    Reconnecting { stop_when_started: bool },
    Removing,
}

struct SessionChangeGuard<'a> {
    changes: &'a Mutex<HashMap<String, SessionChange>>,
    id: &'a str,
}

impl Drop for SessionChangeGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut changes) = self.changes.lock() {
            changes.remove(self.id);
        }
    }
}

/// An engine started ahead of need for one working directory. An engine boot takes seconds
/// (every service, plugin and index client starts), and a conversation used to wait for all of
/// it each time one was opened or resumed. A spare has booted already: claiming it only tells
/// it which conversation it is, and the host connects once it answers.
pub(crate) struct SpareEngine {
    runtime_id: String,
    workdir: String,
    /// The engine command it was started from; a spare from another engine is not used.
    engine: String,
    claimed: Arc<Mutex<Option<std::time::Instant>>>,
    /// The conversation its exit watcher reports to: its own runtime id, or the conversation
    /// that took it over ([`HostState::adopt_spare`]).
    owner: Arc<Mutex<String>>,
    /// When it was started: an old spare carries stale boot-time state and is about to stop.
    started: std::time::Instant,
}

/// Spare engines kept at most, across all working directories. An idle engine holds about a
/// gigabyte, so only the most recently used working directory keeps one.
const SPARE_LIMIT: usize = 1;
/// How long an unclaimed spare waits before it stops itself (the engine enforces it, so a
/// spare left behind by a crashed host still ends). Its boot-time config, plugins and project
/// instructions are this old at most.
const SPARE_MAX_AGE: Duration = Duration::from_secs(20 * 60);
/// A spare this close to its own stop is not handed out: it could exit before it answers.
const SPARE_CLAIM_MARGIN: Duration = Duration::from_secs(60);
/// A refill waits this long after a conversation opens, so the new engine boot does not
/// compete with the conversation the user is looking at.
const SPARE_REFILL_DELAY: Duration = Duration::from_secs(30);
/// How long a spare asked to stop may take for its graceful shutdown before it is stopped hard.
const SPARE_STOP_GRACE: Duration = Duration::from_secs(30);
/// How long an engine asked to stop may take for its graceful shutdown before it is stopped
/// hard. Measured graceful stops of a resumed conversation took 4–6 s.
const ENGINE_STOP_GRACE: Duration = Duration::from_secs(12);
/// Avoid repeatedly invoking the OS stop command while the exit watcher is catching up.
const ENGINE_STOP_RETRY: Duration = Duration::from_secs(1);

/// The claim a spare engine waits for: a new conversation, or a recorded one to resume.
fn spare_claim(history: Option<(&str, bool)>) -> Value {
    match history {
        Some((source, fork)) => json!({"resume": source, "fork": fork}),
        None => json!({}),
    }
}

/// How an engine's exit is reported. A stop the host requested is a normal stop even when the
/// process was stopped hard and its exit code is non-zero; only an unrequested exit is a
/// failure worth a red warning.
fn engine_exit_state(
    success: bool,
    expected_stop: bool,
    restore_error: Option<&str>,
) -> (&'static str, Option<String>) {
    if success || expected_stop {
        ("stopped", None)
    } else {
        (
            "error",
            Some(
                restore_error
                    .unwrap_or("WrongStack engine exited; inspect engine logs")
                    .to_owned(),
            ),
        )
    }
}

/// A command's program and arguments, to tell engines started from different builds apart.
fn command_identity(command: &Command) -> String {
    let mut identity = command.get_program().to_string_lossy().into_owned();
    for arg in command.get_args() {
        identity.push('\0');
        identity.push_str(&arg.to_string_lossy());
    }
    identity
}
impl HostState {
    pub fn new(dir: &Path) -> Result<Arc<Self>> {
        let registry = Registry::open(dir)?;
        registry.recover()?;
        std::fs::create_dir_all(dir.join("transcripts")).map_err(err)?;
        Ok(Arc::new(Self {
            project_runtimes: Mutex::new(HashMap::new()),
            registry: Mutex::new(registry),
            live: Mutex::new(HashMap::new()),
            session_changes: Mutex::new(HashMap::new()),
            dir: dir.into(),
            adopted_engine: Mutex::new(None),
            spares: Mutex::new(Vec::new()),
            aliases: Mutex::new(HashMap::new()),
            warming: Mutex::new(std::collections::HashSet::new()),
        }))
    }
    pub fn request(self: &Arc<Self>, method: &str, p: &Value) -> Result<Value> {
        match method {
            "ping" => Ok(
                json!({"protocol":1,"pid":std::process::id(),"projectApi":1,"engineBuild":crate::host::engine_build(),"requestFrameBytes":crate::host::REQUEST_FRAME_BYTES,"engine":self.engine_command().is_ok()}),
            ),
            "engine.adopt" => self.adopt_engine(field(p, "path")?),
            "snapshot" => {
                let r = self.registry.lock().map_err(err)?;
                Ok(
                    json!({"projects":r.projects()?,"sessions":r.sessions()?,"hostPid":std::process::id(),"layout":r.setting(p["layoutKey"].as_str().unwrap_or("layout"))?,"appearance":r.setting("appearance")?}),
                )
            }
            "project.register" => Ok(json!(self
                .registry
                .lock()
                .map_err(err)?
                .register(field(p, "root")?)?)),
            "project.open" => self.open_project_runtime(
                field(p, "projectId")?,
                p["retry"].as_bool().unwrap_or(false),
            ),
            "project.status" => self.project_runtime_status(field(p, "projectId")?),
            "project.events" => {
                if p["tail"] == true {
                    return self.project_journal_end(field(p, "projectId")?);
                }
                self.project_events(
                    field(p, "projectId")?,
                    p["offset"].as_u64().unwrap_or(0),
                    p["recent"].as_u64(),
                    p["runtimeId"].as_str(),
                )
            }
            "project.send" => self.project_send(field(p, "projectId")?, p["message"].clone()),
            "project.http" => self.project_http(field(p, "projectId")?, p),
            "profile.open" => self.open_profile_runtime(p["retry"].as_bool().unwrap_or(false)),
            "profile.status" => self.runtime_status("@profile"),
            "profile.events" => self.project_events(
                "@profile",
                p["offset"].as_u64().unwrap_or(0),
                p["recent"].as_u64(),
                p["runtimeId"].as_str(),
            ),
            "profile.send" => self.project_send("@profile", p["message"].clone()),
            "profile.http" => self.project_http("@profile", p),
            "session.open" => {
                if p.get("history").is_some() {
                    return Err("Recorded conversations require session.restore".into());
                }
                self.open(p)
            }
            "session.restore" => {
                history_source(p)?.ok_or("Missing history source")?;
                let mut params = p.clone();
                params["kind"] = json!("agent");
                self.open(&params)
            }
            "session.reconnect" => self.reconnect(p),
            "session.prewarm" => self.prewarm(field(p, "id")?),
            "session.read" => self.read(field(p, "id")?, p["offset"].as_u64()),
            "session.write" => {
                let data = field(p, "data")?.to_owned();
                let live = self.live.lock().map_err(err)?;
                let writer = live
                    .get(field(p, "id")?)
                    .and_then(|s| s.writer.as_ref())
                    .map(Arc::clone)
                    .ok_or("Terminal is not running")?;
                drop(live);
                let mut writer = writer.lock().map_err(err)?;
                writer.write_all(data.as_bytes()).map_err(err)?;
                writer.flush().map_err(err)?;
                Ok(Value::Null)
            }
            "session.resize" => {
                let live = self.live.lock().map_err(err)?;
                let master = live
                    .get(field(p, "id")?)
                    .and_then(|s| s.master.as_ref())
                    .ok_or("Terminal is not running")?;
                let rows = dimension(p, "rows")?;
                let cols = dimension(p, "cols")?;
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(err)?;
                Ok(Value::Null)
            }
            "session.kill" => self.stop(field(p, "id")?),
            "session.remove" => self.remove(field(p, "id")?),
            "engine.send" => {
                let id = field(p, "id")?;
                let sent =
                    self.send_engine_command(id, p["message"].clone(), "Engine is still starting")?;
                // A conversation without a name takes its first prompt's. Naming is a
                // convenience: a failure here never fails the prompt that was sent.
                if let Some(prompt) = sent_prompt(&p["message"]) {
                    if let Ok(registry) = self.registry.lock() {
                        let _ = registry.name_untitled(id, prompt);
                    }
                }
                Ok(sent)
            }
            "session.rename" => {
                self.registry
                    .lock()
                    .map_err(err)?
                    .rename(field(p, "id")?, field(p, "title")?)?;
                Ok(Value::Null)
            }
            "engine.events" => {
                let id = field(p, "id")?;
                if !self
                    .registry
                    .lock()
                    .map_err(err)?
                    .sessions()?
                    .iter()
                    .any(|s| s.id == id)
                {
                    return Err("Unknown session".into());
                }
                Engine::events(
                    &self
                        .dir
                        .join("transcripts")
                        .join(format!("{id}.events.jsonl")),
                    p["offset"].as_u64().unwrap_or(0),
                )
            }
            "engine.http" => {
                self.request_engine_http(field(p, "id")?, p, "Engine is still starting")
            }
            "engine.browser_frame" => {
                let live = self.live.lock().map_err(err)?;
                Ok(live
                    .get(field(p, "id")?)
                    .and_then(|s| s.engine.as_ref())
                    .ok_or("Engine is still starting")?
                    .live_frame(p["after"].as_u64().unwrap_or(0)))
            }
            "engine.identity" => {
                let live = self.live.lock().map_err(err)?;
                Ok(live
                    .get(field(p, "id")?)
                    .and_then(|s| s.engine.as_ref())
                    .ok_or("Engine is still starting")?
                    .identity())
            }
            "settings.save" => {
                self.registry
                    .lock()
                    .map_err(err)?
                    .set_setting(field(p, "key")?, field(p, "value")?)?;
                Ok(Value::Null)
            }
            _ => Err(format!("Unknown method: {method}")),
        }
    }
    pub(crate) fn send_engine_command(
        &self,
        id: &str,
        message: Value,
        not_ready: &str,
    ) -> Result<Value> {
        // Queue admission and the stop flag are serialized by the same live lock.
        let live = self.live.lock().map_err(err)?;
        let session = live.get(id).ok_or(not_ready)?;
        if session.stop_requested {
            return Err("Engine is stopping".into());
        }
        session.engine.as_ref().ok_or(not_ready)?.send(message)
    }
    pub(crate) fn request_engine_http(
        &self,
        id: &str,
        params: &Value,
        not_ready: &str,
    ) -> Result<Value> {
        let (engine, method) = {
            let live = self.live.lock().map_err(err)?;
            let session = live.get(id).ok_or(not_ready)?;
            let engine = session.engine.as_ref().ok_or(not_ready)?;
            let method = field(params, "method")?;
            if session.stop_requested && matches!(method, "POST" | "PUT" | "PATCH" | "DELETE") {
                return Err("Engine is stopping".into());
            }
            (Arc::clone(engine), method)
        };
        // Network I/O can outlast shutdown and must not hold the live lock.
        engine.http(
            method,
            field(params, "resource")?,
            &params["body"],
            params["operationId"].as_str(),
        )
    }
    fn open(self: &Arc<Self>, p: &Value) -> Result<Value> {
        self.open_with_terminal(p, |session| self.open_terminal(session))
    }
    fn open_with_terminal(
        self: &Arc<Self>,
        p: &Value,
        start_terminal: impl FnOnce(&Session) -> Result<()>,
    ) -> Result<Value> {
        let history = history_source(p)?;
        let kind = field(p, "kind")?;
        if history.is_some() && (kind != "agent" || p.get("workdir").is_some()) {
            return Err("History opens an agent at its registered project root".into());
        }
        if kind != "terminal" && kind != "agent" {
            return Err("Session kind must be agent or terminal".into());
        }
        let project_id = field(p, "projectId")?;
        let workdir = self
            .registry
            .lock()
            .map_err(err)?
            .workdir(project_id, p["workdir"].as_str())?;
        // An agent conversation opened without a name is named after its first prompt; until
        // then the interface shows a localized placeholder (the stored one is for readers
        // that do not know `untitled`).
        let named = p["title"].as_str().map(str::trim).filter(|t| !t.is_empty());
        let untitled = named.is_none() && kind == "agent";
        let title = named.unwrap_or(if kind == "agent" {
            "New conversation"
        } else {
            "Terminal"
        });
        if title.len() > 200 || title.chars().any(char::is_control) {
            return Err("Title must contain 1–200 bytes without control characters".into());
        }
        let workdir_text = workdir.to_string_lossy().into_owned();
        let spare = if kind == "agent" {
            self.take_spare(&workdir_text)
        } else {
            None
        };
        let s = Session {
            // A claimed spare's runtime id becomes the conversation's: its process, journal,
            // transcript and readiness files are already keyed by it.
            id: spare.as_ref().map_or_else(
                || Uuid::new_v4().to_string(),
                |spare| spare.runtime_id.clone(),
            ),
            project_id: project_id.into(),
            title: title.into(),
            kind: kind.into(),
            workdir: workdir.to_string_lossy().into(),
            status: "starting".into(),
            created_at: now(),
            updated_at: now(),
            exit_code: None,
            error: None,
            untitled,
        };
        let _change = self.begin_session_change(
            &s.id,
            SessionChange::Opening {
                stop_when_started: false,
            },
        )?;
        self.registry.lock().map_err(err)?.insert(&s)?;
        let result = if kind == "terminal" {
            start_terminal(&s)
        } else if let Some(spare) = &spare {
            // The record exists before the claim: the engine may answer at once, and its
            // "running" state must find the conversation to update.
            self.claim_spare(spare, history).inspect_err(|_| {
                let _ = self.kill(&spare.runtime_id, None);
            })
        } else {
            self.start_engine_with_history(&s.id, &s.workdir, true, history)
        };
        if let Err(e) = result {
            self.registry
                .lock()
                .map_err(err)?
                .state(&s.id, "error", None, Some(&e))?;
            return Err(e);
        }
        if !self.apply_deferred_stop(&s.id)? && kind == "agent" {
            self.refill_spare(s.workdir.clone());
        }
        Ok(json!(s))
    }
    /// The paths a spare engine is told its conversation by, and answers through.
    fn spare_files(&self, runtime_id: &str) -> (PathBuf, PathBuf) {
        let transcripts = self.dir.join("transcripts");
        (
            transcripts.join(format!("{runtime_id}.claim.json")),
            transcripts.join(format!("{runtime_id}.restore.json")),
        )
    }
    /// A running spare for `workdir` from the current engine, removed from the pool. Spares
    /// from another engine build are stopped instead.
    fn take_spare(self: &Arc<Self>, workdir: &str) -> Option<SpareEngine> {
        let current = self.engine_command().ok().map(|c| command_identity(&c))?;
        let mut spares = self.spares.lock().ok()?;
        let stale: Vec<String> = spares
            .iter()
            .filter(|spare| spare.engine != current)
            .map(|spare| spare.runtime_id.clone())
            .collect();
        spares.retain(|spare| spare.engine == current);
        let live = self.live.lock().ok()?;
        // A spare about to stop by itself is left alone: it leaves the pool when it exits.
        let index = spares.iter().position(|spare| {
            spare.workdir == workdir
                && live.contains_key(&spare.runtime_id)
                && spare.started.elapsed() < SPARE_MAX_AGE.saturating_sub(SPARE_CLAIM_MARGIN)
        });
        drop(live);
        let taken = index.map(|index| spares.remove(index));
        drop(spares);
        for id in stale {
            self.stop_spare(id);
        }
        taken
    }
    /// Asks a spare the host no longer wants to stop through its claim file, so it shuts down
    /// gracefully and closes its boot session (a hard kill would leave a 0-byte transcript).
    /// One that is still running after [`SPARE_STOP_GRACE`] is stopped hard.
    fn stop_spare(self: &Arc<Self>, runtime_id: String) {
        let _ = self.stop_spare_with(
            runtime_id,
            |host, id, pid| host.kill(id, pid),
            thread::sleep,
        );
    }
    fn stop_spare_with(
        self: &Arc<Self>,
        runtime_id: String,
        mut force_stop: impl FnMut(&HostState, &str, Option<u32>) -> Result<Value> + Send + 'static,
        sleep: impl FnMut(Duration) + Send + 'static,
    ) -> Option<thread::JoinHandle<()>> {
        let mut live = self.live.lock().ok()?;
        let session = live.get_mut(&runtime_id)?;
        let pid = session.agent_pid;
        let (claim, _) = self.spare_files(&runtime_id);
        let next = claim.with_extension("json.tmp");
        let asked = std::fs::write(&next, br#"{"stop":true}"#)
            .and_then(|()| std::fs::rename(&next, &claim))
            .is_ok();
        // After a rollback, a prior stop watchdog is still keyed by the conversation ID.
        session.stop_requested = true;
        drop(live);
        let pid = pid?;
        let grace = if asked {
            SPARE_STOP_GRACE
        } else {
            Duration::ZERO
        };
        let host = Arc::clone(self);
        Some(thread::spawn(move || {
            host.enforce_engine_stop(
                &runtime_id,
                pid,
                grace,
                |id, pid| force_stop(&host, id, Some(pid)),
                sleep,
            );
        }))
    }
    /// Tells a spare which conversation it is; from now on its start has the usual deadline.
    fn claim_spare(&self, spare: &SpareEngine, history: Option<(&str, bool)>) -> Result<()> {
        let (claim, _) = self.spare_files(&spare.runtime_id);
        let next = claim.with_extension("json.tmp");
        std::fs::write(
            &next,
            serde_json::to_vec(&spare_claim(history)).map_err(err)?,
        )
        .map_err(err)?;
        *spare.claimed.lock().map_err(err)? = Some(std::time::Instant::now());
        std::fs::rename(&next, &claim).map_err(err)
    }
    /// Makes a running spare the engine of the stopped conversation `id` and tells it to resume
    /// `history`. The conversation keeps its id, record and journal: the spare's process entry,
    /// exit reports and journal move to `id`, and a stop for `id` reaches the stop file the
    /// spare watches. If the claim cannot be written, everything goes back, the spare is asked
    /// to stop, and the error is returned so the caller boots an engine of its own.
    fn adopt_spare(self: &Arc<Self>, spare: &SpareEngine, id: &str, history: &str) -> Result<()> {
        self.adopt_spare_with_claim(spare, id, history, |next, claim| {
            std::fs::rename(next, claim).map_err(err)
        })
    }
    fn adopt_spare_with_claim(
        self: &Arc<Self>,
        spare: &SpareEngine,
        id: &str,
        history: &str,
        publish_claim: impl FnOnce(&Path, &Path) -> Result<()>,
    ) -> Result<()> {
        {
            let mut live = self.live.lock().map_err(err)?;
            let entry = live
                .remove(&spare.runtime_id)
                .ok_or("The spare engine has stopped")?;
            live.insert(id.to_owned(), entry);
            *spare.owner.lock().map_err(err)? = id.to_owned();
            // Claimed under the live lock: from now on its exit is the conversation's.
            *spare.claimed.lock().map_err(err)? = Some(std::time::Instant::now());
            self.aliases
                .lock()
                .map_err(err)?
                .insert(id.to_owned(), spare.runtime_id.clone());
        }
        let (claim, _) = self.spare_files(&spare.runtime_id);
        let next = claim.with_extension("json.tmp");
        let written = serde_json::to_vec(&spare_claim(Some((history, false))))
            .map_err(err)
            .and_then(|bytes| std::fs::write(&next, bytes).map_err(err))
            .and_then(|()| publish_claim(&next, &claim));
        if let Err(error) = written {
            if let Ok(mut live) = self.live.lock() {
                if let Some(entry) = live.remove(id) {
                    live.insert(spare.runtime_id.clone(), entry);
                }
                if let Ok(mut owner) = spare.owner.lock() {
                    *owner = spare.runtime_id.clone();
                }
                if let Ok(mut claimed) = spare.claimed.lock() {
                    *claimed = None;
                }
            }
            if let Ok(mut aliases) = self.aliases.lock() {
                aliases.remove(id);
            }
            self.stop_spare(spare.runtime_id.clone());
            return Err(error);
        }
        Ok(())
    }
    /// Starts a spare for `workdir` in the background, after [`SPARE_REFILL_DELAY`], unless one
    /// is waiting there, stopping the oldest spares beyond [`SPARE_LIMIT`].
    fn refill_spare(self: &Arc<Self>, workdir: String) {
        self.warm_spare(workdir, SPARE_REFILL_DELAY);
    }
    /// A stopped conversation is on screen: start the spare its reconnect would take now, so
    /// the reconnect resumes in about a second. Nothing happens for a running conversation, a
    /// terminal, or a working directory that has a spare already or is getting one.
    fn prewarm(self: &Arc<Self>, id: &str) -> Result<Value> {
        let session = self
            .registry
            .lock()
            .map_err(err)?
            .sessions()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or("Unknown session")?;
        let stopped = matches!(session.status.as_str(), "stopped" | "error" | "interrupted");
        if session.kind != "agent" || !stopped || self.live.lock().map_err(err)?.contains_key(id) {
            return Ok(json!({ "warming": false }));
        }
        self.warm_spare(session.workdir, Duration::ZERO);
        Ok(json!({ "warming": true }))
    }
    /// Starts a spare for `workdir` in the background after `delay`, unless one is waiting
    /// there or being started, stopping the oldest spares beyond [`SPARE_LIMIT`].
    fn warm_spare(self: &Arc<Self>, workdir: String, delay: Duration) {
        let host = Arc::clone(self);
        thread::spawn(move || {
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let Ok(engine) = host.engine_command().map(|c| command_identity(&c)) else {
                return;
            };
            let first = host
                .warming
                .lock()
                .map(|mut warming| warming.insert(workdir.clone()))
                .unwrap_or(false);
            if !first {
                return;
            }
            host.start_spare(&workdir, engine);
            if let Ok(mut warming) = host.warming.lock() {
                warming.remove(&workdir);
            }
        });
    }
    /// The body of [`HostState::warm_spare`], run while `workdir` is marked as warming.
    fn start_spare(self: &Arc<Self>, workdir: &str, engine: String) {
        let host = self;
        let workdir = workdir.to_owned();
        {
            let Ok(spares) = host.spares.lock() else {
                return;
            };
            if spares
                .iter()
                .any(|spare| spare.workdir == workdir && spare.engine == engine)
            {
                return;
            }
        }
        let runtime_id = Uuid::new_v4().to_string();
        let Ok((claimed, owner)) = host.spawn_engine(&runtime_id, &workdir, true, None, true)
        else {
            return;
        };
        let overflow: Vec<String> = {
            let Ok(mut spares) = host.spares.lock() else {
                return;
            };
            spares.push(SpareEngine {
                runtime_id,
                workdir,
                engine,
                claimed,
                owner,
                started: std::time::Instant::now(),
            });
            let excess = spares.len().saturating_sub(SPARE_LIMIT);
            spares
                .drain(..excess)
                .map(|spare| spare.runtime_id)
                .collect()
        };
        for id in overflow {
            host.stop_spare(id);
        }
    }
    fn begin_session_change<'a>(
        &'a self,
        id: &'a str,
        change: SessionChange,
    ) -> Result<SessionChangeGuard<'a>> {
        let mut changes = self.session_changes.lock().map_err(err)?;
        if let Some(active) = changes.get(id) {
            return Err(match active {
                SessionChange::Opening { .. } => "This session is still opening",
                SessionChange::Reconnecting { .. } => "This conversation's engine is still running",
                SessionChange::Removing => "This conversation is being removed",
            }
            .into());
        }
        changes.insert(id.into(), change);
        Ok(SessionChangeGuard {
            changes: &self.session_changes,
            id,
        })
    }
    fn apply_deferred_stop(self: &Arc<Self>, id: &str) -> Result<bool> {
        let requested = matches!(
            self.session_changes.lock().map_err(err)?.get(id),
            Some(
                SessionChange::Opening {
                    stop_when_started: true
                } | SessionChange::Reconnecting {
                    stop_when_started: true
                }
            )
        );
        if requested {
            self.stop(id)?;
        }
        Ok(requested)
    }
    /// Starts a stopped agent conversation's engine again on its own record and journal,
    /// resuming the WrongStack session it recorded: the conversation keeps its id, its tab and
    /// its history, and its journal continues where the stopped engine left it.
    fn reconnect(self: &Arc<Self>, p: &Value) -> Result<Value> {
        self.reconnect_with_engine_start(p, |session, history| {
            self.start_engine_with_history(
                &session.id,
                &session.workdir,
                true,
                Some((history, false)),
            )
        })
    }
    fn reconnect_with_engine_start(
        self: &Arc<Self>,
        p: &Value,
        start_engine: impl FnOnce(&Session, &str) -> Result<()>,
    ) -> Result<Value> {
        let id = field(p, "id")?;
        let (history, fork) = history_source(p)?.ok_or("Missing history source")?;
        if fork {
            return Err("Reconnecting resumes the conversation's own session".into());
        }
        let _change = self.begin_session_change(
            id,
            SessionChange::Reconnecting {
                stop_when_started: false,
            },
        )?;
        let is_live = self.live.lock().map_err(err)?.contains_key(id);
        let session = {
            let registry = self.registry.lock().map_err(err)?;
            let session = registry
                .sessions()?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or("Unknown session")?;
            if session.kind != "agent" {
                return Err("Only agent conversations have an engine to reconnect".into());
            }
            if is_live || matches!(session.status.as_str(), "running" | "starting" | "stopping") {
                return Err("This conversation's engine is still running".into());
            }
            // Claim the start before another request can read the same stopped record.
            registry.state(id, "starting", None, None)?;
            session
        };
        // A spare already booted in this working directory resumes the conversation in about a
        // second instead of a whole engine boot; without one, or if it cannot be told, the
        // conversation boots its own engine as before.
        if let Some(spare) = self.take_spare(&session.workdir) {
            if self.adopt_spare(&spare, id, history).is_ok() {
                if !self.apply_deferred_stop(id)? {
                    self.refill_spare(session.workdir.clone());
                }
                return Ok(json!({ "id": id }));
            }
        }
        if let Err(e) = start_engine(&session, history) {
            self.registry
                .lock()
                .map_err(err)?
                .state(id, "error", None, Some(&e))?;
            return Err(e);
        }
        self.apply_deferred_stop(id)?;
        Ok(json!({ "id": id }))
    }
    fn log_reader(
        self: &Arc<Self>,
        id: String,
        pid: Option<u32>,
        mut reader: Box<dyn Read + Send>,
        sink: Arc<Mutex<Transcript>>,
        startup: Option<SharedWriter>,
    ) -> thread::JoinHandle<()> {
        let host = Arc::clone(self);
        thread::spawn(move || {
            let report_error = |error: std::io::Error| {
                let detail = format!("Transcript IO: {error}");
                let _ = writeln!(std::io::stderr().lock(), "{id}: {detail}");
                let (Some(pid), Ok(live)) = (pid, host.live.lock()) else {
                    return;
                };
                // A retired reader cannot put its diagnostic on a replacement process.
                if live
                    .get(&id)
                    .is_some_and(|session| session.agent_pid == Some(pid))
                {
                    if let Ok(registry) = host.registry.lock() {
                        let _ = registry.note_transcript_error(&id, &detail);
                    }
                }
            };
            let mut buffer = [0; 32768];
            let mut handshake = CursorHandshake::default();
            let mut sink = Some(sink);
            let result = (|| -> std::io::Result<()> {
                loop {
                    let count = reader.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    let (bytes, reply) = if startup.is_some() {
                        handshake.feed(&buffer[..count])
                    } else {
                        (buffer[..count].to_vec(), false)
                    };
                    if reply {
                        if let Some(writer) = &startup {
                            let mut writer = writer
                                .lock()
                                .map_err(|e| std::io::Error::other(e.to_string()))?;
                            writer.write_all(b"\x1b[1;1R")?;
                            writer.flush()?;
                        }
                    }
                    if let Some(transcript) = sink.as_ref().filter(|_| !bytes.is_empty()) {
                        let append = transcript
                            .lock()
                            .map_err(|e| std::io::Error::other(e.to_string()))
                            .and_then(|mut transcript| transcript.append(&bytes));
                        if let Err(error) = append {
                            // Stop recording this stream. Keep draining the process pipe.
                            sink = None;
                            report_error(error);
                        }
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                report_error(error);
            }
        })
    }
    fn open_terminal(self: &Arc<Self>, s: &Session) -> Result<()> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 110,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(err)?;
        #[cfg(windows)]
        let shell = std::env::var("SystemRoot")
            .map(|p| PathBuf::from(p).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .map_err(err)?;
        #[cfg(not(windows))]
        let shell = PathBuf::from(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(crate::shell_dir::shell_dir(&s.workdir));
        cmd.env("TERM", "xterm-256color");
        #[cfg(windows)]
        cmd.arg("-NoLogo");
        let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let reader = pair.master.try_clone_reader().map_err(err)?;
        let process_id = child.process_id();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(err)?));
        let sink = Transcript::open(&self.dir.join("transcripts"), &s.id)?;
        let _ = self.log_reader(
            s.id.clone(),
            process_id,
            reader,
            sink,
            if cfg!(windows) {
                Some(Arc::clone(&writer))
            } else {
                None
            },
        );
        self.live.lock().map_err(err)?.insert(
            s.id.clone(),
            LiveSession {
                master: Some(pair.master),
                writer: Some(writer),
                killer: Some(killer),
                agent_pid: process_id,
                engine: None,
                stop_requested: false,
            },
        );
        self.registry
            .lock()
            .map_err(err)?
            .state(&s.id, "running", None, None)?;
        let host = Arc::clone(self);
        let id = s.id.clone();
        thread::spawn(move || {
            let status = child.wait();
            host.live.lock().unwrap().remove(&id);
            if let Ok(r) = host.registry.lock() {
                match status {
                    Ok(code) => {
                        let _ = r.state(&id, "stopped", Some(code.exit_code() as i32), None);
                    }
                    Err(e) => {
                        let _ = r.state(&id, "error", None, Some(&e.to_string()));
                    }
                }
            }
        });
        Ok(())
    }
    fn engine_command(&self) -> Result<Command> {
        let adopted = self.adopted_engine.lock().map_err(err)?.clone();
        engine_command(adopted.as_deref())
    }
    /// A host started from a build output with no engine beside it outlives that window, so a
    /// later launch that has an engine hands it over instead of failing every workspace. An
    /// engine the host already has is never replaced.
    fn adopt_engine(&self, path: &str) -> Result<Value> {
        if self.engine_command().is_ok() {
            return Ok(json!({"adopted":false}));
        }
        let path = PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err("Invalid desktop engine executable path".into());
        }
        *self.adopted_engine.lock().map_err(err)? = Some(path);
        Ok(json!({"adopted":true}))
    }
    pub(crate) fn start_engine(
        self: &Arc<Self>,
        runtime_id: &str,
        workdir: &str,
        bind_session: bool,
    ) -> Result<()> {
        self.start_engine_with_history(runtime_id, workdir, bind_session, None)
    }
    fn start_engine_with_history(
        self: &Arc<Self>,
        runtime_id: &str,
        workdir: &str,
        bind_session: bool,
        history: Option<(&str, bool)>,
    ) -> Result<()> {
        self.spawn_engine(runtime_id, workdir, bind_session, history, false)
            .map(|_| ())
    }
    /// Starts an engine. A `spare` one boots and waits for its claim
    /// ([`HostState::claim_spare`]) with no deadline; the host connects to it only after it
    /// answers. Returns when the start was claimed (now, for any other engine).
    fn spawn_engine(
        self: &Arc<Self>,
        runtime_id: &str,
        workdir: &str,
        bind_session: bool,
        history: Option<(&str, bool)>,
        spare: bool,
    ) -> Result<(ClaimTime, Arc<Mutex<String>>)> {
        let reservation = TcpListener::bind("127.0.0.1:0").map_err(err)?;
        let port = reservation.local_addr().map_err(err)?.port();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut command = self.engine_command()?;
        let (claim_path, ready_path) = self.spare_files(runtime_id);
        let stop_path = self.own_stop_file(runtime_id);
        let _ = std::fs::remove_file(&stop_path);
        command.env("WRONGSTACK_DESKTOP_STOP_FILE", &stop_path);
        // Windows does not end a child with its parent: the engine watches this host and stops
        // itself once the host is gone, instead of running on with nobody to stop it.
        command.env(
            "WRONGSTACK_DESKTOP_HOST_PID",
            std::process::id().to_string(),
        );
        let claimed = Arc::new(Mutex::new((!spare).then(std::time::Instant::now)));
        if spare {
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&claim_path);
            command.env("WRONGSTACK_DESKTOP_SPARE_CLAIM", &claim_path);
            command.env(
                "WRONGSTACK_DESKTOP_SPARE_MAX_AGE_MS",
                SPARE_MAX_AGE.as_millis().to_string(),
            );
            command.env("WRONGSTACK_DESKTOP_RESTORE_READY", &ready_path);
        }
        if let Some((id, fork)) = history {
            // A reconnected conversation reuses its runtime id: an earlier restore's answer
            // must not read as this start being ready.
            let _ = std::fs::remove_file(&ready_path);
            command.args(["--resume", id]);
            command.env("WRONGSTACK_DESKTOP_RESTORE_READY", &ready_path);
            if fork {
                command.arg("--fork-session");
            }
        }
        command
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--require-token",
            ])
            .current_dir(workdir)
            .env("WEBUI_TOKEN", &token)
            .env("WEBUI_STRICT_PORT", "1")
            .env("WRONGSTACK_DESKTOP", "1")
            // The registry already resolved project and profile service roots.
            .env(
                "WRONGSTACK_DESKTOP_USE_CWD_AS_PROJECT_ROOT",
                if bind_session { "0" } else { "1" },
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let disabled_frontend = self.dir.join("frontend-disabled");
        std::fs::create_dir_all(&disabled_frontend).map_err(err)?;
        command.env("WRONGSTACK_DESKTOP_EMPTY_DIST", disabled_frontend);
        hide(&mut command);
        // Its own process group, so stopping the session reaches the tools the engine started
        // (Windows uses `taskkill /T` for the same tree).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let sink = Transcript::open(&self.dir.join("transcripts"), runtime_id)?;
        drop(reservation);
        let mut child = command.spawn().map_err(err)?;
        let pid = child.id();
        let _ = self.log_reader(
            runtime_id.to_owned(),
            Some(pid),
            Box::new(child.stdout.take().ok_or("Missing engine stdout")?),
            Arc::clone(&sink),
            None,
        );
        // Separate streams avoid corrupting concurrent JSONL/byte writes to one transcript.
        let _ = self.log_reader(
            runtime_id.to_owned(),
            Some(pid),
            Box::new(child.stderr.take().ok_or("Missing engine stderr")?),
            sink,
            None,
        );
        self.live.lock().map_err(err)?.insert(
            runtime_id.to_owned(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(pid),
                engine: None,
                stop_requested: false,
            },
        );
        let host = Arc::clone(self);
        let id = runtime_id.to_owned();
        // A spare answers through the readiness file too, once it is claimed.
        let restoring = history.is_some() || spare;
        let watched = Arc::clone(&claimed);
        let owner = Arc::new(Mutex::new(runtime_id.to_owned()));
        let owned = Arc::clone(&owner);
        thread::spawn(move || {
            // The conversation this engine serves; a reconnect that takes over a spare changes
            // it (under the live lock) before the claim, so read it for every report.
            let owner = || {
                owned
                    .lock()
                    .map(|o| o.clone())
                    .unwrap_or_else(|_| id.clone())
            };
            // The 90 s start deadline runs from the claim: a spare waits unclaimed for as long
            // as it is not needed.
            let expired = || {
                watched
                    .lock()
                    .ok()
                    .and_then(|at| *at)
                    .is_some_and(|at| at.elapsed() > Duration::from_secs(90))
            };
            let mut ready = false;
            let mut startup_failure: Option<String> = None;
            loop {
                if let Some(message) = startup_failure.as_deref() {
                    if host.finish_failed_engine_start(&id, &owned, message, child.try_wait()) {
                        break;
                    }
                    let _ = child.kill();
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
                let exited = child.try_wait().transpose();
                // Decided under the live lock: a reconnect takes a spare over (and claims it)
                // under the same lock, so an exit is either an unclaimed spare's or the
                // conversation's, never lost between the two.
                let unclaimed_exit = matches!(exited, Some(Ok(_))) && {
                    let mut live = host.live.lock().unwrap();
                    let unclaimed = watched.lock().map(|at| at.is_none()).unwrap_or(false);
                    if unclaimed {
                        host.clear_engine_stop_request(&id, &id);
                        live.remove(&id);
                    }
                    unclaimed
                };
                match exited {
                    Some(Ok(_)) if unclaimed_exit => {
                        // An unclaimed spare stopped (replaced, or the engine exited): it was
                        // never a conversation, so it leaves nothing behind.
                        if let Ok(mut spares) = host.spares.lock() {
                            spares.retain(|spare| spare.runtime_id != id);
                        }
                        let (claim, ready_file) = host.spare_files(&id);
                        let transcripts = host.dir.join("transcripts");
                        for path in [
                            claim,
                            ready_file,
                            transcripts.join(format!("{id}.bin")),
                            transcripts.join(format!("{id}.jsonl")),
                        ] {
                            let _ = std::fs::remove_file(path);
                        }
                        break;
                    }
                    Some(result) => {
                        if host.finish_engine_exit(
                            &id,
                            &owned,
                            result,
                            restoring.then_some(ready_path.as_path()),
                        ) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                    None => {}
                }
                if !ready {
                    if restoring {
                        let restored = std::fs::read(&ready_path)
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                        if let Some(message) =
                            restored.as_ref().and_then(|value| value["error"].as_str())
                        {
                            startup_failure = Some(message.to_owned());
                            continue;
                        }
                        if restored
                            .as_ref()
                            .and_then(|value| value["sessionId"].as_str())
                            .is_none()
                        {
                            if expired() {
                                startup_failure =
                                    Some("Recorded conversation startup timed out".into());
                                continue;
                            }
                            // A claimed spare answers within moments; check it often.
                            let quick =
                                spare && watched.lock().map(|at| at.is_some()).unwrap_or(false);
                            thread::sleep(Duration::from_millis(if quick { 25 } else { 250 }));
                            continue;
                        }
                    }
                    if let Ok(engine) = Engine::connect(
                        port,
                        &token,
                        &host
                            .dir
                            .join("transcripts")
                            .join(format!("{}.events.jsonl", owner())),
                        bind_session,
                    ) {
                        let mut live = host.live.lock().unwrap();
                        let conversation = owner();
                        if let Some(session) = live.get_mut(&conversation) {
                            host.attach_ready_engine(&conversation, session, engine);
                        }
                        ready = true;
                    } else if expired() {
                        startup_failure =
                            Some("WrongStack engine startup timed out after 90 seconds".into());
                        continue;
                    }
                }
                // A claimed spare is polled quickly: its readiness answer is the whole wait.
                let claimed_spare = spare && watched.lock().map(|at| at.is_some()).unwrap_or(false);
                thread::sleep(Duration::from_millis(if !ready && claimed_spare {
                    25
                } else {
                    250
                }));
            }
            let conversation = owner();
            if conversation != id {
                // These files are private to the retired spare.
                let (claim, ready_file) = host.spare_files(&id);
                let transcripts = host.dir.join("transcripts");
                for path in [
                    claim,
                    ready_file,
                    transcripts.join(format!("{id}.bin")),
                    transcripts.join(format!("{id}.jsonl")),
                ] {
                    let _ = std::fs::remove_file(path);
                }
            }
        });
        Ok((claimed, owner))
    }
    fn finish_failed_engine_start(
        &self,
        runtime_id: &str,
        owner: &Mutex<String>,
        message: &str,
        exit: std::io::Result<Option<std::process::ExitStatus>>,
    ) -> bool {
        if !matches!(exit, Ok(Some(_))) {
            return false;
        }
        let _ = self.release_engine(runtime_id, owner);
        let conversation = owner
            .lock()
            .map(|id| id.clone())
            .unwrap_or_else(|_| runtime_id.to_owned());
        let _ = self.publish_runtime_state(&conversation, "error", None, Some(message));
        true
    }
    fn finish_engine_exit(
        &self,
        runtime_id: &str,
        owner: &Mutex<String>,
        result: std::io::Result<std::process::ExitStatus>,
        restore_result: Option<&Path>,
    ) -> bool {
        let Ok(code) = result else {
            // The process may still be running. Keep its ownership and pending stop request.
            return false;
        };
        let expected_stop = self.release_engine(runtime_id, owner);
        let restore_error = restore_result
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value["error"].as_str().map(str::to_owned));
        let conversation = owner
            .lock()
            .map(|id| id.clone())
            .unwrap_or_else(|_| runtime_id.to_owned());
        let (status, error) =
            engine_exit_state(code.success(), expected_stop, restore_error.as_deref());
        let _ = self.publish_runtime_state(&conversation, status, code.code(), error.as_deref());
        true
    }
    fn attach_ready_engine(&self, id: &str, session: &mut LiveSession, engine: Arc<Engine>) {
        // A stop asked for while the engine was still starting could not mark it then: mark it
        // now, so the disconnect its exit causes is reported as expected, not as a failure.
        if session.stop_requested {
            engine.request_stop();
            return;
        }
        session.engine = Some(engine);
        let _ = self.publish_runtime_state(id, "running", None, None);
    }
    /// Releases an engine and reports whether the host had asked it to stop, so its exit is
    /// reported as a normal stop rather than a failure.
    fn release_engine(&self, runtime_id: &str, owner: &Mutex<String>) -> bool {
        let mut live = self.live.lock().unwrap();
        let conversation = owner
            .lock()
            .map(|id| id.clone())
            .unwrap_or_else(|_| runtime_id.to_owned());
        let expected_stop = live
            .get(&conversation)
            .is_some_and(|session| session.stop_requested);
        // A cold reconnect can reuse this path as soon as the conversation is released.
        self.clear_engine_stop_request(runtime_id, &conversation);
        live.remove(&conversation);
        expected_stop
    }
    fn clear_engine_stop_request(&self, runtime_id: &str, conversation: &str) {
        let _ = std::fs::remove_file(self.own_stop_file(runtime_id));
        if let Ok(mut aliases) = self.aliases.lock() {
            if aliases.get(conversation).is_some_and(|id| id == runtime_id) {
                aliases.remove(conversation);
            }
        }
    }
    /// The stop file the engine started under `runtime_id` was told to watch.
    fn own_stop_file(&self, runtime_id: &str) -> PathBuf {
        self.dir
            .join("transcripts")
            .join(format!("{runtime_id}.stop"))
    }
    /// The file the engine serving conversation `id` watches for a graceful stop request
    /// (`WRONGSTACK_DESKTOP_STOP_FILE`): its own, or the one of the spare it took over.
    fn stop_file(&self, id: &str) -> PathBuf {
        let runtime = self
            .aliases
            .lock()
            .ok()
            .and_then(|aliases| aliases.get(id).cloned());
        self.own_stop_file(runtime.as_deref().unwrap_or(id))
    }
    /// Stops a session. An engine is asked first, through its stop file, so it runs its
    /// graceful shutdown: every conversation journal it holds gets its `session_end` (a killed
    /// one read as a crash on the next launch) and an unused boot session is closed as a
    /// strictly empty journal the empty-session sweep can remove. One still running after
    /// [`ENGINE_STOP_GRACE`] is stopped hard; terminals are stopped hard at once.
    pub(crate) fn stop(self: &Arc<Self>, id: &str) -> Result<Value> {
        let mut live = self.live.lock().map_err(err)?;
        let session = live.get_mut(id);
        {
            let mut changes = self.session_changes.lock().map_err(err)?;
            match changes.get_mut(id) {
                // Reconnect may replace a live spare if its claim fails.
                Some(SessionChange::Reconnecting { stop_when_started }) => {
                    *stop_when_started = true;
                }
                Some(SessionChange::Opening { stop_when_started }) if session.is_none() => {
                    *stop_when_started = true;
                }
                _ if session.is_none() => return Err("Session is not running".into()),
                _ => {}
            }
        }
        let Some(session) = session else {
            return Ok(Value::Null);
        };
        if session.stop_requested {
            return Ok(Value::Null);
        }
        let Some(pid) = session.agent_pid.filter(|_| session.master.is_none()) else {
            drop(live);
            return self.kill(id, None);
        };
        // Mark the shutdown before asking for it: whichever way the engine leaves, its exit
        // and disconnect are a stop the host requested, not an engine failure to report.
        if let Some(engine) = session.engine.as_ref() {
            engine.request_stop();
        }
        // Keep exit and reconnect from replacing this engine during the stop request.
        let grace = if std::fs::write(self.stop_file(id), b"").is_ok() {
            ENGINE_STOP_GRACE
        } else {
            Self::kill_live_session(session)?;
            ENGINE_STOP_RETRY
        };
        // The shutdown takes seconds: the conversation shows as stopping (no longer live, not
        // yet offered for reconnect) until its engine exits.
        session.stop_requested = true;
        let _ = self.publish_runtime_state(id, "stopping", None, None);
        drop(live);
        let host = Arc::clone(self);
        let id = id.to_owned();
        thread::spawn(move || {
            host.enforce_engine_stop(
                &id,
                pid,
                grace,
                |id, pid| host.kill(id, Some(pid)),
                thread::sleep,
            );
        });
        Ok(Value::Null)
    }
    fn enforce_engine_stop(
        &self,
        id: &str,
        pid: u32,
        grace: Duration,
        mut force_stop: impl FnMut(&str, u32) -> Result<Value>,
        mut sleep: impl FnMut(Duration),
    ) {
        let deadline = std::time::Instant::now() + grace;
        // Only this engine: a reconnect may start another one on the same id meanwhile.
        let running = || {
            self.live
                .lock()
                .map(|live| {
                    live.get(id)
                        .is_some_and(|s| s.stop_requested && s.agent_pid == Some(pid))
                })
                .unwrap_or(false)
        };
        while running() {
            if std::time::Instant::now() >= deadline {
                let _ = force_stop(id, pid);
                sleep(ENGINE_STOP_RETRY);
            } else {
                sleep(Duration::from_millis(100));
            }
        }
    }
    fn read(&self, id: &str, offset: Option<u64>) -> Result<Value> {
        if !self
            .registry
            .lock()
            .map_err(err)?
            .sessions()?
            .iter()
            .any(|s| s.id == id)
        {
            return Err("Unknown session".into());
        }
        let path = self.dir.join("transcripts").join(format!("{id}.bin"));
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"offset":0,"bytes":[],"end":0}))
            }
            Err(e) => return Err(err(e)),
        };
        let end = file.metadata().map_err(err)?.len();
        let offset = offset
            .unwrap_or_else(|| end.saturating_sub(262144))
            .min(end);
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut bytes = vec![0; 65536];
        let n = file.read(&mut bytes).map_err(err)?;
        bytes.truncate(n);
        Ok(json!({"offset":offset+n as u64,"bytes":bytes,"end":end}))
    }
    /// Forgets a session: a running one is stopped first, then its row, drafts and desktop
    /// transcript go. The WrongStack conversation an agent recorded stays in the project history.
    fn remove(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _change = self.begin_session_change(id, SessionChange::Removing)?;
        if let Err(error) = self.stop(id) {
            // A normal exit may beat the stop. The removal reservation holds off any reconnect.
            if self.live.lock().map_err(err)?.contains_key(id) {
                return Err(error);
            }
        }
        // Wait for the exit watcher to release the process before deleting the session.
        let deadline = std::time::Instant::now() + ENGINE_STOP_GRACE + Duration::from_secs(10);
        while self.live.lock().map_err(err)?.contains_key(id) {
            if std::time::Instant::now() > deadline {
                return Err("The session did not stop; try again".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !self.registry.lock().map_err(err)?.remove(id)? {
            return Err("Unknown session".into());
        }
        for extension in ["bin", "jsonl", "events.jsonl", "events.jsonl.seed.json"] {
            // Best effort: a file still held open is left behind rather than failing the removal.
            let _ = std::fs::remove_file(
                self.dir
                    .join("transcripts")
                    .join(format!("{id}.{extension}")),
            );
        }
        Ok(Value::Null)
    }
    fn kill(&self, id: &str, expected_pid: Option<u32>) -> Result<Value> {
        let mut live = self.live.lock().map_err(err)?;
        let session = live.get_mut(id).ok_or("Session is not running")?;
        // A delayed stop belongs to the engine that was running when it was requested.
        if expected_pid.is_some() && session.agent_pid != expected_pid {
            return Ok(Value::Null);
        }
        Self::kill_live_session(session)
    }
    fn kill_live_session(session: &mut LiveSession) -> Result<Value> {
        if !cfg!(windows) {
            if let Some(killer) = session.killer.as_mut() {
                killer.kill().map_err(err)?;
            }
        }
        if let Some(pid) = session.agent_pid {
            #[cfg(windows)]
            {
                crate::windows_process::stop_tree(pid)?;
            }
            #[cfg(not(windows))]
            {
                // The engine leads its own process group: signal the whole group.
                Command::new("kill")
                    .args(["-TERM", "--", &format!("-{pid}")])
                    .status()
                    .map_err(err)?;
            }
        }
        Ok(Value::Null)
    }
}
/// The prompt text an engine message carries: a user message sent now, or one queued for later.
fn sent_prompt(message: &Value) -> Option<&str> {
    match message["type"].as_str()? {
        "user_message" => crate::registry::user_message_text(&message["payload"]),
        "queue.add" => message["payload"]["journalRaw"]
            .as_str()
            .filter(|raw| !raw.trim().is_empty())
            .or_else(|| message["payload"]["text"].as_str()),
        _ => None,
    }
}
fn history_source(p: &Value) -> Result<Option<(&str, bool)>> {
    let Some(source) = p.get("history") else {
        return Ok(None);
    };
    let id = field(source, "id")?;
    // Only project-relative journal identities. No prefix switches, traversal,
    // absolute paths or platform-specific path spellings reach the CLI.
    if id.is_empty()
        || id.len() > 512
        || id.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('-')
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
    {
        return Err("Invalid recorded session identity".into());
    }
    let fork = match field(source, "mode")? {
        "resume" => false,
        "fork" => true,
        _ => return Err("History mode must be resume or fork".into()),
    };
    Ok(Some((id, fork)))
}

#[cfg(test)]
mod history_tests {
    use super::*;

    #[test]
    fn an_engine_exit_the_host_requested_is_a_normal_stop() {
        assert_eq!(engine_exit_state(true, false, None), ("stopped", None));
        assert_eq!(
            engine_exit_state(false, true, Some("fixture restore failed")),
            ("stopped", None),
            "a hard stop the host asked for must not surface as an engine failure"
        );
        let (status, error) = engine_exit_state(false, false, None);
        assert_eq!(status, "error");
        assert_eq!(
            error.as_deref(),
            Some("WrongStack engine exited; inspect engine logs")
        );
        assert_eq!(
            engine_exit_state(false, false, Some("startup restore failed")),
            ("error", Some("startup restore failed".into()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn stopping_a_terminal_during_initial_open_reaches_its_shell() {
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("desktop-stop-opening-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.to_str().unwrap())
            .unwrap();
        let params = json!({"projectId":project.id,"kind":"terminal"});
        let (row_visible, published) = mpsc::channel();
        let (begin_startup, allowed) = mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker_params = params.clone();
        let open = thread::spawn(move || {
            worker_host.open_with_terminal(&worker_params, |session| {
                row_visible.send(session.id.clone()).unwrap();
                allowed.recv_timeout(Duration::from_secs(5)).unwrap();
                worker_host.open_terminal(session)
            })
        });
        let id = published.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!host.live.lock().unwrap().contains_key(&id));
        let stop = || host.request("session.kill", &json!({"id":id}));
        let first_stop = stop();
        let repeated_stop = stop();
        begin_startup.send(()).unwrap();
        open.join().unwrap().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let stopped = loop {
            let status = host.registry.lock().unwrap().sessions().unwrap()[0]
                .status
                .clone();
            if status == "stopped" {
                break true;
            }
            if first_stop.is_err() || std::time::Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(10));
        };
        let still_live = host.live.lock().unwrap().contains_key(&id);
        host.request("session.remove", &json!({"id":id})).unwrap();
        let unknown_stop = stop();

        let mut failed_id = None;
        let failed_open = host.open_with_terminal(&params, |session| {
            failed_id = Some(session.id.clone());
            assert_eq!(
                host.request("session.kill", &json!({"id":session.id})),
                Ok(Value::Null)
            );
            Err("Fixture terminal startup failed".into())
        });
        let failed_id = failed_id.unwrap();
        let live_after_failure = host.live.lock().unwrap().contains_key(&failed_id);
        let stop_after_failure = host.request("session.kill", &json!({"id":failed_id}));
        host.request("session.remove", &json!({"id":failed_id}))
            .unwrap();
        drop(host);
        let _ = std::fs::remove_dir_all(dir);

        println!("EXPECTED: early stop is accepted and the shell exits");
        println!(
            "ACTUAL: stop {first_stop:?}, terminal stopped {stopped}, live shell {still_live}"
        );
        assert_eq!(first_stop, Ok(Value::Null));
        assert_eq!(repeated_stop, Ok(Value::Null));
        assert!(stopped);
        assert!(!still_live);
        assert_eq!(unknown_stop, Err("Session is not running".into()));
        assert_eq!(failed_open, Err("Fixture terminal startup failed".into()));
        assert!(!live_after_failure);
        assert_eq!(stop_after_failure, Err("Session is not running".into()));
    }

    #[cfg(windows)]
    #[test]
    fn removing_a_terminal_cannot_race_its_initial_open() {
        use std::sync::mpsc;
        let dir = std::env::temp_dir().join(format!("desktop-opening-terminal-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.to_str().unwrap())
            .unwrap();
        let (registered, opened_row) = mpsc::channel();
        let (resume, released) = mpsc::channel();
        let worker_host = Arc::clone(&host);
        let params = json!({"projectId":project.id,"kind":"terminal"});
        let open_params = params.clone();
        let open = thread::spawn(move || {
            worker_host.open_with_terminal(&open_params, |session| {
                registered.send(session.id.clone()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
                worker_host.open_terminal(session)
            })
        });
        let id = opened_row.recv_timeout(Duration::from_secs(5)).unwrap();
        // This is the exact interval a second window can see a starting row without a process.
        let during_open = host.request("session.remove", &json!({"id":id}));
        resume.send(()).unwrap();
        open.join().unwrap().unwrap();
        let tracked = host.live.lock().unwrap().contains_key(&id);
        let status = host
            .registry
            .lock()
            .unwrap()
            .sessions()
            .unwrap()
            .into_iter()
            .find(|session| session.id == id)
            .map(|session| session.status);
        println!("EXPECTED: opening is reserved and the terminal keeps its row");
        println!(
            "ACTUAL: remove during open {during_open:?}, live shell {tracked}, row {status:?}"
        );
        let after_open = host.request("session.remove", &json!({"id":id}));
        assert!(
            !host.live.lock().unwrap().contains_key(&id),
            "cleanup must stop the test shell"
        );

        let mut failed_id = None;
        let failed_open = host.open_with_terminal(&params, |session| {
            failed_id = Some(session.id.clone());
            Err("Fixture terminal startup failed".into())
        });
        let after_failure = host.request("session.remove", &json!({"id":failed_id.unwrap()}));
        drop(host);
        let _ = std::fs::remove_dir_all(dir);

        assert_eq!(during_open, Err("This session is still opening".into()));
        assert!(tracked);
        assert_eq!(status.as_deref(), Some("running"));
        assert_eq!(after_open, Ok(Value::Null));
        assert_eq!(failed_open, Err("Fixture terminal startup failed".into()));
        assert_eq!(after_failure, Ok(Value::Null));
    }

    #[test]
    fn transcript_write_failure_does_not_close_the_output_pipe() {
        use std::sync::mpsc;

        struct ObservedPipe {
            reader: std::io::PipeReader,
            reads: mpsc::Sender<()>,
        }
        impl Read for ObservedPipe {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let _ = self.reads.send(());
                self.reader.read(buffer)
            }
        }

        let dir = std::env::temp_dir().join(format!("desktop-transcript-pipe-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let raw = dir.join("transcripts").join("read-only.bin");
        let journal = dir.join("transcripts").join("read-only.jsonl");
        std::fs::write(&raw, b"").unwrap();
        let sink = Transcript::from_files(File::open(raw).unwrap(), File::create(journal).unwrap());
        let (reader, mut writer) = std::io::pipe().unwrap();
        let (mut reply_reader, reply_writer) = std::io::pipe().unwrap();
        let startup: SharedWriter = Arc::new(Mutex::new(Box::new(reply_writer)));
        let (reads, received) = mpsc::channel();
        let worker = host.log_reader(
            "failed".into(),
            None,
            Box::new(ObservedPipe { reader, reads }),
            sink,
            Some(startup),
        );
        received.recv_timeout(Duration::from_secs(4)).unwrap();
        writer.write_all(b"unwritable chunk").unwrap();
        // The next read cannot be announced until the first chunk's append has returned.
        let next_read = received.recv_timeout(Duration::from_secs(4));
        let second_write = writer.write_all(b"\x1b[6nlater output");
        drop(writer);
        worker.join().unwrap();
        let mut reply = Vec::new();
        reply_reader.read_to_end(&mut reply).unwrap();

        let healthy = Transcript::open(&dir.join("transcripts"), "healthy").unwrap();
        host.log_reader(
            "healthy".into(),
            None,
            Box::new(std::io::Cursor::new(b"control output")),
            healthy,
            None,
        )
        .join()
        .unwrap();
        let recorded = std::fs::read(dir.join("transcripts").join("healthy.bin")).unwrap();
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(recorded, b"control output");
        assert!(next_read.is_ok() && second_write.is_ok(), "output must keep flowing after an append failure: read {next_read:?}, write {second_write:?}");
        assert_eq!(reply, b"\x1b[1;1R", "the terminal handshake remains active");
    }

    #[test]
    fn transcript_failure_preserves_the_session_exit_state() {
        use std::sync::mpsc;
        struct GatedReader(mpsc::Receiver<()>);
        impl Read for GatedReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                self.0.recv_timeout(Duration::from_secs(4)).unwrap();
                Err(std::io::Error::other("fixture transcript failure"))
            }
        }
        let dir = std::env::temp_dir().join(format!("desktop-transcript-state-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "conversation";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    title: "Transcript fixture".into(),
                    kind: "agent".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "running".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: None,
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        let track = |pid| {
            host.live.lock().unwrap().insert(
                id.into(),
                LiveSession {
                    master: None,
                    writer: None,
                    killer: None,
                    agent_pid: Some(pid),
                    engine: None,
                    stop_requested: false,
                },
            );
        };
        let spawn_reader = |pid| {
            let (release, gate) = mpsc::channel();
            let sink = Transcript::open(&dir.join("transcripts"), id).unwrap();
            let reader = host.log_reader(
                id.into(),
                Some(pid),
                Box::new(GatedReader(gate)),
                sink,
                None,
            );
            (release, reader)
        };
        let snapshot = || host.registry.lock().unwrap().sessions().unwrap().remove(0);
        track(41);
        let (release, reader) = spawn_reader(41);
        // Publish the process exit before allowing the output worker to report its failure.
        host.live.lock().unwrap().remove(id);
        host.publish_runtime_state(id, "stopped", Some(0), None)
            .unwrap();
        release.send(()).unwrap();
        reader.join().unwrap();
        let stopped = snapshot();

        let (release, old_reader) = spawn_reader(41);
        track(42);
        host.publish_runtime_state(id, "running", None, None)
            .unwrap();
        release.send(()).unwrap();
        old_reader.join().unwrap();
        let replacement = snapshot();

        let (release, current_reader) = spawn_reader(42);
        host.publish_runtime_state(id, "stopping", None, None)
            .unwrap();
        release.send(()).unwrap();
        current_reader.join().unwrap();
        let stopping = snapshot();
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.exit_code, Some(0));
        assert_eq!(stopped.error, None);
        assert_eq!(replacement.status, "running");
        assert_eq!(
            replacement.error, None,
            "the old reader must not annotate a new engine"
        );
        assert_eq!(stopping.status, "stopping");
        assert_eq!(
            stopping.error.as_deref(),
            Some("Transcript IO: fixture transcript failure")
        );
    }

    #[cfg(windows)]
    struct FixtureChild(std::process::Child);
    #[cfg(windows)]
    impl FixtureChild {
        fn spawn() -> Self {
            let ping =
                PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/ping.exe");
            let mut command = Command::new(ping);
            hide(&mut command);
            Self(
                command
                    .args(["-t", "127.0.0.1"])
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        }
    }
    #[cfg(windows)]
    impl Drop for FixtureChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(windows)]
    #[test]
    fn failed_engine_start_remains_owned_until_the_child_exits() {
        let dir = std::env::temp_dir().join(format!("desktop-startup-stop-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        // Retrying before the fixture child exits must not launch a second process.
        std::fs::write(dir.join("frontend-disabled"), b"fixture").unwrap();
        let open = |retry| {
            host.request("profile.open", &json!({"retry":retry}))
                .unwrap()
        };
        let current_id = || {
            host.project_events("@profile", 0, None, None).unwrap()["runtimeId"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(open(false)["status"], "error");
        let id = current_id();
        let owner = Mutex::new(id.clone());
        let mut child = FixtureChild::spawn();
        host.live.lock().unwrap().insert(
            id.clone(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(child.0.id()),
                engine: None,
                stop_requested: false,
            },
        );
        host.publish_runtime_state(&id, "starting", None, None)
            .unwrap();

        let message = "WrongStack engine startup timed out after 90 seconds";
        let probe_failure = std::io::Error::other("Fixture could not confirm exit");
        let finished_before_exit =
            host.finish_failed_engine_start(&id, &owner, message, Err(probe_failure));
        let before_exit = open(true);
        let id_before_exit = current_id();
        let tracked_before_exit = host.live.lock().unwrap().contains_key(&id);
        let pending_exit = child.0.try_wait().unwrap();
        assert!(pending_exit.is_none());
        let finished_while_running =
            host.finish_failed_engine_start(&id, &owner, message, Ok(pending_exit));

        child.0.kill().unwrap();
        let exit = child.0.wait().map(Some);
        let finished_after_exit = host.finish_failed_engine_start(&id, &owner, message, exit);
        let after_exit = host.runtime_status("@profile").unwrap();
        let tracked_after_exit = host.live.lock().unwrap().contains_key(&id);
        open(true);
        let id_after_exit = current_id();
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();

        assert_eq!(
            before_exit["status"], "starting",
            "retry may not replace a child whose exit is unconfirmed"
        );
        assert_eq!(id_before_exit, id);
        assert!(tracked_before_exit);
        assert!(!finished_before_exit);
        assert!(!finished_while_running);
        assert!(finished_after_exit);
        assert_eq!(after_exit["status"], "error");
        assert_eq!(after_exit["error"], message);
        assert!(!tracked_after_exit);
        assert_ne!(id_after_exit, id);
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_engine_exit_probe_does_not_allow_project_replacement() {
        let dir = std::env::temp_dir().join(format!("desktop-exit-probe-{}", Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(repo.to_str().unwrap())
            .unwrap();
        // Fixture startup attempts must never create a second process.
        std::fs::write(dir.join("frontend-disabled"), b"fixture").unwrap();
        let open = |retry| {
            host.request(
                "project.open",
                &json!({"projectId":project.id,"retry":retry}),
            )
            .unwrap()
        };
        assert_eq!(open(false)["status"], "error");
        let current_id = || {
            host.project_events(&project.id, 0, None, None).unwrap()["runtimeId"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let id = current_id();
        let owner = Mutex::new(id.clone());
        let mut child = FixtureChild::spawn();
        host.live.lock().unwrap().insert(
            id.clone(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(child.0.id()),
                engine: None,
                stop_requested: false,
            },
        );
        host.publish_runtime_state(&id, "running", None, None)
            .unwrap();

        let finished = host.finish_engine_exit(
            &id,
            &owner,
            Err(std::io::Error::other("Fixture exit probe failure")),
            None,
        );
        let status_during_retry = open(true)["status"].clone();
        let id_during_retry = current_id();
        let child_still_live = child.0.try_wait().unwrap().is_none();

        // Hold an accepted stop request while the next probe also fails.
        let stop_file = host.own_stop_file(&id);
        std::fs::write(&stop_file, b"").unwrap();
        host.live
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .stop_requested = true;
        host.publish_runtime_state(&id, "stopping", None, None)
            .unwrap();
        let finished_while_stopping = host.finish_engine_exit(
            &id,
            &owner,
            Err(std::io::Error::other("Fixture second exit probe failure")),
            None,
        );
        let status_while_stopping = open(true)["status"].clone();
        let stop_preserved = stop_file.is_file();

        child.0.kill().unwrap();
        let code = child.0.wait().unwrap();
        let finished_after_exit = host.finish_engine_exit(&id, &owner, Ok(code), None);
        let still_tracked = host.live.lock().unwrap().contains_key(&id);
        let stop_after_exit = stop_file.exists();
        let after_exit = host.runtime_status(&project.id).unwrap()["status"].clone();
        open(true);
        let id_after_exit = current_id();
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();

        assert!(child_still_live);
        assert_eq!(
            status_during_retry, "running",
            "a failed exit probe must not allow a new engine to start"
        );
        assert_eq!(id_during_retry, id);
        assert!(!finished, "the same child must still be watched");
        assert!(!finished_while_stopping);
        assert_eq!(status_while_stopping, "stopping");
        assert!(stop_preserved);
        assert!(finished_after_exit);
        assert!(!still_tracked);
        assert!(!stop_after_exit);
        assert_eq!(
            after_exit, "stopped",
            "the accepted stop makes even a hard exit a normal stop"
        );
        assert_ne!(id_after_exit, id);
    }

    #[test]
    fn a_host_started_without_an_engine_takes_one_from_a_later_launch() {
        if std::env::var_os("WRONGSTACK_DESKTOP_ENGINE").is_some()
            || std::env::var_os("WRONGSTACK_DESKTOP_ENTRY").is_some()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!("desktop-engine-adopt-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        assert_eq!(host.request("ping", &json!({})).unwrap()["engine"], false);
        assert!(host.engine_command().unwrap_err().contains("portable"));
        assert!(host
            .request("engine.adopt", &json!({"path":"relative-engine.exe"}))
            .is_err());
        let engine = dir.join("wrongstack-engine.exe");
        std::fs::write(&engine, b"").unwrap();
        let path = engine.to_string_lossy().to_string();
        assert_eq!(
            host.request("engine.adopt", &json!({"path":path})).unwrap()["adopted"],
            true
        );
        assert_eq!(host.request("ping", &json!({})).unwrap()["engine"], true);
        // An engine the host already has is never replaced.
        let other = dir.join("other.exe");
        std::fs::write(&other, b"").unwrap();
        assert_eq!(
            host.request("engine.adopt", &json!({"path":other.to_string_lossy()}))
                .unwrap()["adopted"],
            false
        );
        assert_eq!(
            host.engine_command().unwrap().get_program(),
            engine.as_os_str()
        );
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_conversation_takes_a_running_spare_of_its_workdir_and_engine_and_tells_it_who_it_is() {
        if std::env::var_os("WRONGSTACK_DESKTOP_ENGINE").is_some()
            || std::env::var_os("WRONGSTACK_DESKTOP_ENTRY").is_some()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!("desktop-spare-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        std::fs::create_dir_all(dir.join("transcripts")).unwrap();
        assert!(host.take_spare("w1").is_none(), "no engine, no spare");
        let engine = dir.join("wrongstack-engine.exe");
        std::fs::write(&engine, b"").unwrap();
        host.request("engine.adopt", &json!({"path": engine.to_string_lossy()}))
            .unwrap();
        let current = command_identity(&host.engine_command().unwrap());
        let spare = |id: &str, workdir: &str, engine: &str| SpareEngine {
            runtime_id: id.into(),
            workdir: workdir.into(),
            engine: engine.into(),
            claimed: Arc::new(Mutex::new(None)),
            owner: Arc::new(Mutex::new(id.into())),
            started: std::time::Instant::now(),
        };
        let idle = || LiveSession {
            master: None,
            writer: None,
            killer: None,
            agent_pid: None,
            engine: None,
            stop_requested: false,
        };
        {
            let mut spares = host.spares.lock().unwrap();
            spares.push(spare("gone", "w1", &current));
            spares.push(spare("old", "w1", "older engine"));
            spares.push(spare("other", "w2", &current));
            let mut aged = spare("aged", "w1", &current);
            aged.started = std::time::Instant::now() - (SPARE_MAX_AGE - SPARE_CLAIM_MARGIN);
            spares.push(aged);
            spares.push(spare("ready", "w1", &current));
            let mut live = host.live.lock().unwrap();
            for id in ["old", "other", "aged", "ready"] {
                live.insert(id.into(), idle());
            }
        }
        let taken = host.take_spare("w1").expect("the running spare of w1");
        assert_eq!(taken.runtime_id, "ready");
        let left: Vec<String> = host
            .spares
            .lock()
            .unwrap()
            .iter()
            .map(|spare| spare.runtime_id.clone())
            .collect();
        assert_eq!(
            left,
            ["gone", "other", "aged"],
            "another engine's spare is dropped; a stopped one and one near its own stop are skipped"
        );
        let (old_claim, _) = host.spare_files("old");
        let stop: Value = serde_json::from_slice(&std::fs::read(&old_claim).unwrap()).unwrap();
        assert_eq!(
            stop,
            json!({"stop": true}),
            "another engine's spare is asked to stop gracefully, not killed"
        );
        assert!(host.take_spare("w1").is_none());

        host.claim_spare(&taken, Some(("2026-11-12/sess_1", true)))
            .unwrap();
        assert!(
            taken.claimed.lock().unwrap().is_some(),
            "the deadline starts"
        );
        let (claim, _) = host.spare_files("ready");
        let written: Value = serde_json::from_slice(&std::fs::read(&claim).unwrap()).unwrap();
        assert_eq!(written, json!({"resume":"2026-11-12/sess_1","fork":true}));
        assert_eq!(spare_claim(None), json!({}));
        drop(host);
        // Best effort: the stop request's grace thread still holds the host (and its registry).
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(windows)]
    fn discarded_spare_force_stop_retries_the_same_process() {
        let dir =
            std::env::temp_dir().join(format!("desktop-spare-force-retry-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "discarded-spare";
        let mut child = FixtureChild::spawn();
        let pid = child.0.id();
        host.live.lock().unwrap().insert(
            id.into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(pid),
                engine: None,
                // A conversation may already have asked it to stop before adoption rolled back.
                stop_requested: true,
            },
        );
        std::fs::create_dir(host.spare_files(id).0).unwrap();
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::clone(&attempts);
        host.stop_spare_with(
            id.into(),
            move |host, target, expected_pid| {
                let attempt = {
                    let mut entries = calls.lock().unwrap();
                    entries.push(expected_pid);
                    entries.len()
                };
                if attempt == 1 {
                    return Err("Fixture force stop failed".into());
                }
                assert_eq!(attempt, 2);
                host.kill(target, expected_pid).unwrap();
                child.0.wait().unwrap();
                host.live.lock().unwrap().remove(target);
                Ok(Value::Null)
            },
            |_| {},
        )
        .unwrap()
        .join()
        .unwrap();
        let tracked = host.live.lock().unwrap().contains_key(id);
        let requested = attempts.lock().unwrap().clone();
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
        println!("EXPECTED: retry force stop using the discarded spare's PID");
        println!("ACTUAL: calls {requested:?}, still tracked {tracked}");
        assert_eq!(requested, [Some(pid), Some(pid)]);
        assert!(!tracked);
    }

    #[test]
    fn discarded_spare_can_exit_from_its_graceful_claim() {
        let dir = std::env::temp_dir().join(format!("desktop-spare-grace-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "graceful-spare";
        assert!(host
            .stop_spare_with(
                id.into(),
                |_, _, _| panic!("an absent spare cannot be stopped"),
                |_| panic!("an absent spare has no watchdog"),
            )
            .is_none());
        let (claim, _) = host.spare_files(id);
        assert!(!claim.exists());
        host.live.lock().unwrap().insert(
            id.into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(u32::MAX),
                engine: None,
                stop_requested: false,
            },
        );
        let worker_host = Arc::clone(&host);
        host.stop_spare_with(
            id.into(),
            |_, _, _| panic!("the spare exits during its graceful window"),
            move |_| {
                let stop: Value = serde_json::from_slice(&std::fs::read(&claim).unwrap()).unwrap();
                assert_eq!(stop, json!({"stop":true}));
                assert!(
                    worker_host
                        .live
                        .lock()
                        .unwrap()
                        .remove(id)
                        .unwrap()
                        .stop_requested
                );
            },
        )
        .unwrap()
        .join()
        .unwrap();
        assert!(!host.live.lock().unwrap().contains_key(id));
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn force_stop_is_retried_while_the_same_engine_is_tracked() {
        let dir = std::env::temp_dir().join(format!("desktop-stop-retry-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "stopping-engine";
        let pid = 41;
        let track_engine = || {
            host.live.lock().unwrap().insert(
                id.into(),
                LiveSession {
                    master: None,
                    writer: None,
                    killer: None,
                    agent_pid: Some(pid),
                    engine: None,
                    stop_requested: true,
                },
            );
        };
        track_engine();
        let mut attempts = 0;
        let mut pauses = Vec::new();
        host.enforce_engine_stop(
            id,
            pid,
            Duration::ZERO,
            |target, expected| {
                assert_eq!((target, expected), (id, pid));
                attempts += 1;
                match attempts {
                    1 => Err("Fixture force stop failed".into()),
                    2 => Ok(Value::Null), // Acceptance still leaves the exit unconfirmed.
                    3 => {
                        host.live.lock().unwrap().remove(id);
                        Ok(Value::Null)
                    }
                    _ => panic!("continued after the old engine exited"),
                }
            },
            |delay| pauses.push(delay),
        );
        assert_eq!(attempts, 3, "one failure must not end the stop watchdog");
        assert_eq!(pauses, vec![ENGINE_STOP_RETRY; 3]);

        track_engine();
        let mut attempts_before_replacement = 0;
        host.enforce_engine_stop(
            id,
            pid,
            Duration::ZERO,
            |_, _| {
                attempts_before_replacement += 1;
                Err("Fixture force stop failed".into())
            },
            |_| host.live.lock().unwrap().get_mut(id).unwrap().agent_pid = Some(pid + 1),
        );
        assert_eq!(attempts_before_replacement, 1);

        track_engine();
        host.enforce_engine_stop(
            id,
            pid,
            ENGINE_STOP_GRACE,
            |_, _| panic!("graceful exit must not force termination"),
            |_| {
                host.live.lock().unwrap().remove(id);
            },
        );
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stopping_an_engine_asks_it_through_its_stop_file_first() {
        let dir = std::env::temp_dir().join(format!("desktop-stop-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("transcripts")).unwrap();
        let host = HostState::new(&dir).unwrap();
        assert!(host.stop("absent").is_err(), "nothing runs under that id");
        host.live.lock().unwrap().insert(
            "engine".into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                // No such process: the hard-stop fallback must never be reached in this test.
                agent_pid: Some(u32::MAX),
                engine: None,
                stop_requested: false,
            },
        );
        let stop_file = host.stop_file("engine");
        let registry = host.registry.lock().unwrap();
        let stopping_host = Arc::clone(&host);
        let stopper = thread::spawn(move || stopping_host.stop("engine"));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !stop_file.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let asked = stop_file.exists();
        let held_during_publish = matches!(
            host.live.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        );
        drop(registry);
        stopper.join().unwrap().unwrap();
        std::fs::write(&stop_file, b"existing marker").unwrap();
        host.stop("engine").unwrap();
        assert_eq!(std::fs::read(&stop_file).unwrap(), b"existing marker");
        // The engine "exits": the grace thread sees it gone and does nothing more.
        host.live.lock().unwrap().remove("engine");
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
        assert!(
            asked,
            "the engine is asked to stop gracefully before any hard stop"
        );
        assert!(
            held_during_publish,
            "the live engine must remain reserved until the stop state is published"
        );
    }

    #[test]
    fn attached_engines_reject_new_commands_after_stop() {
        use std::sync::mpsc;
        use tungstenite::Message;

        let dir = std::env::temp_dir().join(format!("desktop-stop-send-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "stopping-engine";
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.to_str().unwrap())
            .unwrap();
        host.registry
            .lock()
            .unwrap()
            .insert(&Session {
                id: id.into(),
                project_id: project.id.clone(),
                title: "Test conversation".into(),
                kind: "agent".into(),
                workdir: dir.to_string_lossy().into(),
                status: "running".into(),
                created_at: now(),
                updated_at: now(),
                exit_code: None,
                error: None,
                untitled: false,
            })
            .unwrap();
        // Register the runtime IDs without spawning extra children for this connection fixture.
        std::fs::write(dir.join("frontend-disabled"), b"fixture").unwrap();
        host.open_project_runtime(&project.id, false).unwrap();
        host.open_profile_runtime(false).unwrap();
        let runtime_id = |project| {
            host.project_events(project, 0, None, None).unwrap()["runtimeId"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let project_runtime = runtime_id(&project.id);
        let profile_runtime = runtime_id("@profile");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (observed, received) = mpsc::channel();
        let (ended, finish) = mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            for _ in 0..3 {
                observed
                    .send(socket.read().unwrap().into_text().unwrap())
                    .unwrap();
            }
            finish.recv_timeout(Duration::from_secs(4)).unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"session_end","payload":{}})
                        .to_string()
                        .into(),
                ))
                .unwrap();
        });
        let engine = Engine::connect(
            port,
            "fixture",
            &dir.join("transcripts").join(format!("{id}.events.jsonl")),
            true,
        )
        .unwrap();
        let runtimes = [id, project_runtime.as_str(), profile_runtime.as_str()];
        for id in runtimes {
            host.live.lock().unwrap().insert(
                id.into(),
                LiveSession {
                    master: None,
                    writer: None,
                    killer: None,
                    agent_pid: Some(u32::MAX),
                    engine: Some(Arc::clone(&engine)),
                    stop_requested: false,
                },
            );
        }
        for id in [&project_runtime, &profile_runtime] {
            host.publish_runtime_state(id, "running", None, None)
                .unwrap();
        }
        let commands = [
            (
                "engine.send",
                json!({"id":id,"message":{"type":"user_message","payload":{"text":"fixture turn"}}}),
            ),
            (
                "project.send",
                json!({"projectId":project.id,"message":{"type":"goal.list","payload":{}}}),
            ),
            (
                "profile.send",
                json!({"message":{"type":"prefs.get","payload":{}}}),
            ),
        ];
        for (method, params) in &commands {
            host.request(method, params).unwrap();
            let frame: Value =
                serde_json::from_str(&received.recv_timeout(Duration::from_secs(4)).unwrap())
                    .unwrap();
            assert_eq!(frame["type"], params["message"]["type"]);
        }

        for id in runtimes {
            host.request("session.kill", &json!({"id":id})).unwrap();
        }
        let after_stop = commands.map(|(method, params)| host.request(method, &params));
        let writes_after_stop = ["POST", "PUT", "PATCH", "DELETE"].map(|method| {
            [
                host.request(
                    "engine.http",
                    &json!({"id":id,"method":method,"resource":"/api/fixture"}),
                ),
                host.request(
                    "project.http",
                    &json!({"projectId":project.id,"method":method,"resource":"/api/fixture"}),
                ),
                host.request(
                    "profile.http",
                    &json!({"method":method,"resource":"/api/fixture"}),
                ),
            ]
        });
        ended.send(()).unwrap();
        server.join().unwrap();
        let read = || {
            host.request("engine.events", &json!({"id":id,"offset":0}))
                .unwrap()
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let terminal = loop {
            let page = read();
            if page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "session_end")
            {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            thread::yield_now();
        };
        host.live.lock().unwrap().clear();
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(
            after_stop,
            std::array::from_fn(|_| Err("Engine is stopping".into()))
        );
        for result in writes_after_stop.into_iter().flatten() {
            assert_eq!(result, Err("Engine is stopping".into()));
        }
        assert!(
            terminal,
            "the final engine event remains readable during shutdown"
        );
    }

    #[test]
    fn late_readiness_does_not_attach_a_stopping_engine() {
        let dir = std::env::temp_dir().join(format!("desktop-stop-ready-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "stopping-engine";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    title: "Late readiness".into(),
                    kind: "agent".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "starting".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: None,
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        host.live.lock().unwrap().insert(
            id.into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(u32::MAX),
                engine: None,
                stop_requested: false,
            },
        );
        host.request("session.kill", &json!({"id": id})).unwrap();
        std::fs::remove_file(host.stop_file(id)).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || tungstenite::accept(listener.accept().unwrap().0));
        let engine =
            Engine::connect(port, "fixture", &dir.join("late.events.jsonl"), true).unwrap();
        let socket = server.join().unwrap().unwrap();
        let attached = {
            let mut live = host.live.lock().unwrap();
            let session = live.get_mut(id).unwrap();
            host.attach_ready_engine(id, session, engine);
            session.engine.is_some()
        };
        let status = host.registry.lock().unwrap().sessions().unwrap()[0]
            .status
            .clone();
        host.live.lock().unwrap().remove(id);
        drop(socket);
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
        assert!(!attached);
        assert_eq!(status, "stopping");
    }

    #[test]
    fn a_stop_asked_for_before_the_engine_is_ready_marks_its_disconnect_as_expected() {
        let dir = std::env::temp_dir().join(format!("desktop-stop-early-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "stopping-engine";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    title: "Early stop".into(),
                    kind: "agent".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "starting".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: None,
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        host.live.lock().unwrap().insert(
            id.into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(u32::MAX),
                engine: None,
                stop_requested: false,
            },
        );
        // Accepted while no engine exists yet, so the stop cannot have marked one.
        host.request("session.kill", &json!({"id": id})).unwrap();

        let journal = dir.join("early.events.jsonl");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || tungstenite::accept(listener.accept().unwrap().0));
        let engine = Engine::connect(port, "fixture", &journal, true).unwrap();
        let socket = server.join().unwrap().unwrap();
        let attached = {
            let mut live = host.live.lock().unwrap();
            let session = live.get_mut(id).unwrap();
            host.attach_ready_engine(id, session, engine);
            session.engine.is_some()
        };
        let status = host.registry.lock().unwrap().sessions().unwrap()[0]
            .status
            .clone();
        host.live.lock().unwrap().remove(id);
        // The refused engine then leaves, as one stopping from its stop file does.
        drop(socket);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let disconnected = loop {
            let journaled = std::fs::read_to_string(&journal).ok().and_then(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|frame| frame["type"] == "desktop.disconnected")
            });
            if let Some(frame) = journaled {
                break frame;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the refused engine's disconnect was never journaled"
            );
            thread::sleep(Duration::from_millis(20));
        };
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
        assert!(!attached);
        assert_eq!(status, "stopping");
        assert_eq!(
            disconnected["payload"]["expected"],
            json!(true),
            "a stop asked for before the engine was ready must not leave an engine-failure frame"
        );
        assert_eq!(disconnected["payload"]["message"], json!(null));
    }

    #[cfg(windows)]
    #[test]
    fn force_stop_without_a_stop_file_keeps_shutdown_owned_until_exit() {
        let dir =
            std::env::temp_dir().join(format!("desktop-stop-file-fallback-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "stop-file-blocked";
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(dir.to_str().unwrap())
            .unwrap();
        host.registry
            .lock()
            .unwrap()
            .insert(&Session {
                id: id.into(),
                project_id: project.id,
                title: "Fallback fixture".into(),
                kind: "agent".into(),
                workdir: dir.to_string_lossy().into(),
                status: "running".into(),
                created_at: now(),
                updated_at: now(),
                exit_code: None,
                error: None,
                untitled: false,
            })
            .unwrap();
        let mut child = FixtureChild::spawn();
        host.live.lock().unwrap().insert(
            id.into(),
            LiveSession {
                agent_pid: Some(child.0.id()),
                master: None,
                writer: None,
                killer: None,
                engine: None,
                stop_requested: false,
            },
        );
        // A directory at the stop marker path denies the file write without changing permissions.
        std::fs::create_dir(host.stop_file(id)).unwrap();
        host.request("session.kill", &json!({"id":id})).unwrap();
        let pending = host.live.lock().unwrap()[id].stop_requested;
        let status = host.registry.lock().unwrap().sessions().unwrap()[0]
            .status
            .clone();
        let rejected = host.request(
            "engine.send",
            &json!({"id":id,"message":{"type":"user_message"}}),
        );
        let exit = child.0.wait().unwrap();
        // Deliberately publish the real process exit after observing the accepted stop state.
        let finalized = host.finish_engine_exit(id, &Mutex::new(id.into()), Ok(exit), None);
        let status_after_exit = host.registry.lock().unwrap().sessions().unwrap()[0]
            .status
            .clone();
        let live_after_exit = host.live.lock().unwrap().contains_key(id);
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(
            status, "stopping",
            "the fallback must publish the stop before the exit watcher runs"
        );
        assert!(pending);
        assert_eq!(rejected, Err("Engine is stopping".into()));
        assert!(finalized);
        assert_eq!(
            status_after_exit, "stopped",
            "a hard stop the host requested is a normal stop, never an engine failure"
        );
        assert!(!live_after_exit);
    }

    #[cfg(windows)]
    #[test]
    fn a_force_stop_targets_only_the_expected_engine_pid() {
        let dir = std::env::temp_dir().join(format!("desktop-force-stop-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let program =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/PING.EXE");
        let mut command = Command::new(program);
        command
            .args(["-t", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        host.live.lock().unwrap().insert(
            "engine".into(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(pid),
                engine: None,
                stop_requested: false,
            },
        );

        let stale_stop = host.kill("engine", Some(u32::MAX));
        let after_stale_stop = child.try_wait();
        let current_stop = host.kill("engine", Some(pid));
        let after_current_stop = child.try_wait();
        let _ = child.kill();
        let _ = child.wait();
        drop(host);
        let _ = std::fs::remove_dir_all(dir);

        assert!(stale_stop.is_ok());
        assert!(after_stale_stop.unwrap().is_none());
        assert!(current_stop.is_ok(), "{current_stop:?}");
        assert!(after_current_stop.unwrap().is_some());
    }

    #[test]
    fn restore_requires_a_source_and_refuses_alternate_roots_before_creating_tabs() {
        let dir = std::env::temp_dir().join(format!("desktop-restore-contract-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        assert!(host
            .request("session.restore", &json!({}))
            .unwrap_err()
            .contains("Missing history source"));
        assert!(host
            .request(
                "session.open",
                &json!({"history":{"id":"sess_ok","mode":"resume"}})
            )
            .unwrap_err()
            .contains("session.restore"));
        assert!(host
            .request(
                "session.restore",
                &json!({"history":{"id":"sess_ok","mode":"resume"},"workdir":"outside"})
            )
            .unwrap_err()
            .contains("project root"));
        assert!(host.registry.lock().unwrap().sessions().unwrap().is_empty());
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// How long a reconnect test waits for one step on another thread. Windows serializes
    /// process creation inside a process, so in a loaded suite a step that spawns its fixture
    /// can take several seconds; a hang still fails, it just takes longer to report.
    #[cfg(windows)]
    const RECONNECT_STEP_WAIT: Duration = Duration::from_secs(30);

    #[test]
    #[cfg(windows)]
    fn stop_survives_failed_spare_adoption_during_reconnect() {
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("desktop-stop-adopt-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "reconnecting-conversation";
        let spare_id = "provisional-spare";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    kind: "agent".into(),
                    title: "Spare rollback fixture".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "stopped".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: Some(0),
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        let track = |pid| LiveSession {
            master: None,
            writer: None,
            killer: None,
            agent_pid: Some(pid),
            engine: None,
            stop_requested: false,
        };
        let mut spare_child = FixtureChild::spawn();
        let spare_pid = spare_child.0.id();
        host.live
            .lock()
            .unwrap()
            .insert(spare_id.into(), track(spare_pid));
        let owner = Arc::new(Mutex::new(spare_id.into()));
        let spare = SpareEngine {
            runtime_id: spare_id.into(),
            workdir: dir.to_string_lossy().into(),
            engine: "fixture".into(),
            claimed: Arc::new(Mutex::new(None)),
            owner: Arc::clone(&owner),
            started: std::time::Instant::now(),
        };
        std::fs::create_dir(host.spare_files(spare_id).0).unwrap();

        let (provisional, assigned) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let (replacement, started) = mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = thread::spawn(move || {
            let reconnect = json!({"id":id,"history":{"id":"sess_fixture","mode":"resume"}});
            // Keep the real claim, rollback and startup completion paths, with explicit process
            // fixtures in place of engine boot and a gate before the failing claim rename.
            worker_host.reconnect_with_engine_start(&reconnect, |session, history| {
                let adopted = worker_host.adopt_spare_with_claim(
                    &spare,
                    &session.id,
                    history,
                    |next, claim| {
                        provisional.send(()).unwrap();
                        gate.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
                        std::fs::rename(next, claim).map_err(err)
                    },
                );
                assert!(adopted.is_err(), "a directory blocks the real claim rename");
                let cold = FixtureChild::spawn();
                worker_host
                    .live
                    .lock()
                    .unwrap()
                    .insert(session.id.clone(), track(cold.0.id()));
                replacement.send(cold).unwrap();
                Ok(())
            })
        });
        assigned.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
        assert_eq!(host.live.lock().unwrap()[id].agent_pid, Some(spare_pid));
        let stop = host.request("session.kill", &json!({"id":id}));
        let targeted_spare = host.own_stop_file(spare_id).is_file();
        release.send(()).unwrap();
        let mut cold = started.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
        worker.join().unwrap().unwrap();
        let cold_stop_requested = host.live.lock().unwrap()[id].stop_requested;
        let cold_stop_file = host.own_stop_file(id).is_file();
        let returned_owner = owner.lock().unwrap().clone();

        for child in [&mut spare_child, &mut cold] {
            let _ = child.0.kill();
            child.0.wait().unwrap();
        }
        host.release_engine(spare_id, &owner);
        host.release_engine(id, &Mutex::new(id.into()));
        drop(host);
        let _ = std::fs::remove_dir_all(dir);

        println!(
            "EXPECTED: an acknowledged stop survives rollback and reaches the cold replacement"
        );
        println!("ACTUAL: stop {stop:?}, provisional marker {targeted_spare}, replacement flag {cold_stop_requested}, replacement marker {cold_stop_file}");
        assert_eq!(stop, Ok(Value::Null));
        assert_eq!(returned_owner, spare_id);
        assert!(targeted_spare);
        assert!(cold_stop_requested);
        assert!(cold_stop_file);
    }

    #[test]
    #[cfg(windows)]
    fn stop_during_reconnect_reaches_the_replacement_engine() {
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("desktop-stop-reconnect-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "reconnecting-conversation";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    kind: "agent".into(),
                    title: "Reconnect fixture".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "stopped".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: Some(0),
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        let reconnect = json!({"id":id,"history":{"id":"sess_fixture","mode":"resume"}});
        let (start_ready, begin) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let (child, started) = mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = thread::spawn(move || {
            worker_host.reconnect_with_engine_start(&reconnect, |session, _| {
                start_ready.send(()).unwrap();
                gate.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
                let replacement = FixtureChild::spawn();
                worker_host.live.lock().unwrap().insert(
                    session.id.clone(),
                    LiveSession {
                        master: None,
                        writer: None,
                        killer: None,
                        agent_pid: Some(replacement.0.id()),
                        engine: None,
                        stop_requested: false,
                    },
                );
                child.send(replacement).unwrap();
                Ok(())
            })
        });
        begin.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
        assert_eq!(
            host.registry.lock().unwrap().sessions().unwrap()[0].status,
            "starting"
        );
        assert!(!host.live.lock().unwrap().contains_key(id));
        let early_stop = host.request("session.kill", &json!({"id":id}));
        release.send(()).unwrap();
        let mut replacement = started.recv_timeout(RECONNECT_STEP_WAIT).unwrap();
        assert_eq!(worker.join().unwrap().unwrap()["id"], id);
        let requested = host.live.lock().unwrap()[id].stop_requested;
        let stop_file = host.stop_file(id);
        let marker_written = stop_file.exists();
        let status = host.registry.lock().unwrap().sessions().unwrap()[0]
            .status
            .clone();
        assert!(replacement.0.try_wait().unwrap().is_none());
        replacement.0.kill().unwrap();
        let exit = replacement.0.wait().unwrap();
        host.finish_engine_exit(id, &Mutex::new(id.into()), Ok(exit), None);
        let live_after_exit = host.live.lock().unwrap().contains_key(id);
        let reconnect = json!({"id":id,"history":{"id":"sess_fixture","mode":"resume"}});
        let failed = host.reconnect_with_engine_start(&reconnect, |_, _| {
            assert_eq!(
                host.request("session.kill", &json!({"id":id})),
                Ok(Value::Null)
            );
            Err("Fixture reconnect failed".into())
        });
        let failure = host.registry.lock().unwrap().sessions().unwrap().remove(0);
        let stop_after_failure = host.request("session.kill", &json!({"id":id}));
        drop(host);
        let _ = std::fs::remove_dir_all(dir);

        println!("EXPECTED: stop is accepted before the replacement is registered and applied to that process");
        println!("ACTUAL: {early_stop:?}, stop flag {requested}, stop marker {marker_written}, state {status}");
        assert_eq!(early_stop, Ok(Value::Null));
        assert!(requested);
        assert!(marker_written);
        assert_eq!(status, "stopping");
        assert!(!live_after_exit);
        assert_eq!(failed, Err("Fixture reconnect failed".into()));
        assert_eq!(failure.error.as_deref(), Some("Fixture reconnect failed"));
        assert_eq!(stop_after_failure, Err("Session is not running".into()));
    }

    #[test]
    fn reconnect_takes_over_a_running_spare_and_keeps_the_conversation_id() {
        if std::env::var_os("WRONGSTACK_DESKTOP_ENGINE").is_some()
            || std::env::var_os("WRONGSTACK_DESKTOP_ENTRY").is_some()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!("desktop-reconnect-spare-{}", Uuid::new_v4()));
        let project_dir = dir.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        // An engine file that cannot start: a cold boot shows as an error, a spare never boots.
        let engine = dir.join("wrongstack-engine.exe");
        std::fs::write(&engine, b"").unwrap();
        host.request("engine.adopt", &json!({"path": engine.to_string_lossy()}))
            .unwrap();
        let current = command_identity(&host.engine_command().unwrap());
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(project_dir.to_str().unwrap())
            .unwrap();
        let workdir = project_dir.to_string_lossy().to_string();
        let record = || {
            let s = Session {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                title: "test".into(),
                kind: "agent".into(),
                workdir: workdir.clone(),
                status: "interrupted".into(),
                created_at: now(),
                updated_at: now(),
                exit_code: None,
                error: None,
                untitled: false,
            };
            host.registry.lock().unwrap().insert(&s).unwrap();
            s.id
        };
        let pool = |id: &str| {
            let owner = Arc::new(Mutex::new(id.to_owned()));
            let claimed = Arc::new(Mutex::new(None));
            host.spares.lock().unwrap().push(SpareEngine {
                runtime_id: id.into(),
                workdir: workdir.clone(),
                engine: current.clone(),
                claimed: Arc::clone(&claimed),
                owner: Arc::clone(&owner),
                started: std::time::Instant::now(),
            });
            host.live.lock().unwrap().insert(
                id.into(),
                LiveSession {
                    master: None,
                    writer: None,
                    killer: None,
                    // No such process: a hard stop must never be reached in this test.
                    agent_pid: Some(u32::MAX),
                    engine: None,
                    stop_requested: false,
                },
            );
            (owner, claimed)
        };
        let resume = |id: &str| json!({"id": id, "history": {"id": "sess_ok", "mode": "resume"}});
        let status = |id: &str| {
            host.registry
                .lock()
                .unwrap()
                .sessions()
                .unwrap()
                .into_iter()
                .find(|s| s.id == id)
                .map(|s| s.status)
        };

        // A spare of the workdir becomes the conversation's engine, under the conversation's id.
        let conversation = record();
        let (owner, claimed) = pool("spare-1");
        host.request("session.reconnect", &resume(&conversation))
            .unwrap();
        assert_eq!(status(&conversation).as_deref(), Some("starting"));
        assert_eq!(
            *owner.lock().unwrap(),
            conversation,
            "exit reports go to the conversation"
        );
        assert!(claimed.lock().unwrap().is_some(), "its start deadline runs");
        {
            let live = host.live.lock().unwrap();
            assert!(live.contains_key(&conversation));
            assert!(!live.contains_key("spare-1"));
        }
        assert!(host.spares.lock().unwrap().is_empty());
        let (claim, _) = host.spare_files("spare-1");
        let written: Value = serde_json::from_slice(&std::fs::read(&claim).unwrap()).unwrap();
        assert_eq!(written, json!({"resume": "sess_ok", "fork": false}));
        assert_eq!(
            host.registry.lock().unwrap().sessions().unwrap().len(),
            1,
            "no record is made for the spare"
        );
        // A stop for the conversation reaches the stop file the spare was started with.
        assert_eq!(host.stop_file(&conversation), host.own_stop_file("spare-1"));
        host.stop(&conversation).unwrap();
        assert!(host.own_stop_file("spare-1").exists());
        assert!(!host.own_stop_file(&conversation).exists());
        host.release_engine("spare-1", &owner);
        assert!(!host.live.lock().unwrap().contains_key(&conversation));
        assert!(!host.own_stop_file("spare-1").exists());
        assert_eq!(
            host.stop_file(&conversation),
            host.own_stop_file(&conversation)
        );

        // Hold selection of a warm spare until Stop has arrived for the starting conversation.
        let queued_stop = record();
        let (owner, _) = pool("spare-queued-stop");
        let selection_gate = host.spares.lock().unwrap();
        let reconnect_host = Arc::clone(&host);
        let reconnect_params = resume(&queued_stop);
        let reconnect =
            thread::spawn(move || reconnect_host.request("session.reconnect", &reconnect_params));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while status(&queued_stop).as_deref() != Some("starting") {
            assert!(
                std::time::Instant::now() < deadline,
                "warm reconnect never started"
            );
            thread::yield_now();
        }
        let stop = host.request("session.kill", &json!({"id":queued_stop}));
        drop(selection_gate);
        reconnect.join().unwrap().unwrap();
        let warm_status = status(&queued_stop);
        let stopped_spare = host.own_stop_file("spare-queued-stop").is_file();
        host.release_engine("spare-queued-stop", &owner);
        assert_eq!(stop, Ok(Value::Null));
        assert_eq!(warm_status.as_deref(), Some("stopping"));
        assert!(stopped_spare);

        // A spare that cannot be told goes back and stops; the conversation boots its own engine.
        let second = record();
        let (owner, claimed) = pool("spare-2");
        let (blocked, _) = host.spare_files("spare-2");
        std::fs::create_dir_all(blocked.join("occupied")).unwrap();
        let cold = host.request("session.reconnect", &resume(&second));
        assert!(
            cold.is_err(),
            "the engine file cannot start: the cold boot ran"
        );
        assert_eq!(status(&second).as_deref(), Some("error"));
        assert_eq!(*owner.lock().unwrap(), "spare-2");
        assert!(claimed.lock().unwrap().is_none());
        assert!(host.live.lock().unwrap().contains_key("spare-2"));
        assert_eq!(host.stop_file(&second), host.own_stop_file(&second));

        // Without a spare, reconnect boots an engine exactly as before.
        let third = record();
        assert!(host.request("session.reconnect", &resume(&third)).is_err());
        assert_eq!(status(&third).as_deref(), Some("error"));
        drop(host);
        // Best effort: refill and stop-grace threads still hold the host.
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prewarm_warms_only_for_a_stopped_agent_conversation() {
        let dir = std::env::temp_dir().join(format!("desktop-prewarm-{}", Uuid::new_v4()));
        let project_dir = dir.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(project_dir.to_str().unwrap())
            .unwrap();
        let record = |kind: &str, status: &str| {
            let s = Session {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                title: "test".into(),
                kind: kind.into(),
                workdir: project_dir.to_string_lossy().into(),
                status: status.into(),
                created_at: now(),
                updated_at: now(),
                exit_code: None,
                error: None,
                untitled: false,
            };
            host.registry.lock().unwrap().insert(&s).unwrap();
            s.id
        };
        let warm = |id: &str| host.request("session.prewarm", &json!({ "id": id }));
        assert!(warm("missing").unwrap_err().contains("Unknown session"));
        for (kind, status) in [
            ("agent", "running"),
            ("agent", "starting"),
            ("terminal", "stopped"),
        ] {
            assert_eq!(warm(&record(kind, status)).unwrap()["warming"], false);
        }
        // Without an engine the background start ends at once; the request itself only asks.
        // A machine with an engine configured would boot a real one here: skip that part.
        if host.engine_command().is_ok() {
            return;
        }
        assert_eq!(
            warm(&record("agent", "interrupted")).unwrap()["warming"],
            true
        );
        assert!(host.spares.lock().unwrap().is_empty());
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removal_and_reconnect_exclude_competing_requests_for_the_same_session() {
        let dir = std::env::temp_dir().join(format!("desktop-remove-reconnect-{}", Uuid::new_v4()));
        let host = HostState::new(&dir).unwrap();
        let id = "session-to-remove";
        {
            let registry = host.registry.lock().unwrap();
            let project = registry.register(dir.to_str().unwrap()).unwrap();
            registry
                .insert(&Session {
                    id: id.into(),
                    project_id: project.id,
                    title: "Session lifecycle".into(),
                    kind: "agent".into(),
                    workdir: dir.to_string_lossy().into(),
                    status: "stopped".into(),
                    created_at: now(),
                    updated_at: now(),
                    exit_code: None,
                    error: None,
                    untitled: false,
                })
                .unwrap();
        }
        let transcript = dir.join("transcripts").join(format!("{id}.jsonl"));
        std::fs::write(&transcript, b"test transcript").unwrap();
        let remove = || host.request("session.remove", &json!({"id": id}));
        let reconnect = || {
            host.request(
                "session.reconnect",
                &json!({"id": id, "history": {"id": "sess_ok", "mode": "resume"}}),
            )
        };
        {
            let _removing = host
                .begin_session_change(id, SessionChange::Removing)
                .unwrap();
            assert!(reconnect().unwrap_err().contains("being removed"));
            assert!(remove().unwrap_err().contains("being removed"));
            assert!(host
                .begin_session_change(
                    "another-session",
                    SessionChange::Reconnecting {
                        stop_when_started: false
                    },
                )
                .is_ok());
        }
        {
            let _reconnecting = host
                .begin_session_change(
                    id,
                    SessionChange::Reconnecting {
                        stop_when_started: false,
                    },
                )
                .unwrap();
            assert!(remove().unwrap_err().contains("still running"));
            assert!(transcript.exists());
        }
        assert!(host
            .request("session.kill", &json!({"id": id}))
            .unwrap_err()
            .contains("Session is not running"));
        remove().unwrap();
        assert!(!transcript.exists());
        assert!(reconnect().unwrap_err().contains("Unknown session"));
        assert!(remove().unwrap_err().contains("Unknown session"));
        assert!(remove().unwrap_err().contains("Unknown session"));
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reconnect_refuses_unknown_terminal_active_and_forked_conversations() {
        let dir = std::env::temp_dir().join(format!("desktop-reconnect-{}", Uuid::new_v4()));
        let project_dir = dir.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        let project = host
            .registry
            .lock()
            .unwrap()
            .register(project_dir.to_str().unwrap())
            .unwrap();
        let record = |kind: &str, status: &str| {
            let s = Session {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                title: "test".into(),
                kind: kind.into(),
                workdir: project_dir.to_string_lossy().into(),
                status: status.into(),
                created_at: now(),
                updated_at: now(),
                exit_code: None,
                error: None,
                untitled: false,
            };
            host.registry.lock().unwrap().insert(&s).unwrap();
            s.id
        };
        let resume = |id: &str| json!({"id": id, "history": {"id": "sess_ok", "mode": "resume"}});
        assert!(host
            .request("session.reconnect", &json!({"id": "missing"}))
            .unwrap_err()
            .contains("Missing history source"));
        assert!(host
            .request("session.reconnect", &resume("missing"))
            .unwrap_err()
            .contains("Unknown session"));
        let terminal = record("terminal", "stopped");
        assert!(host
            .request("session.reconnect", &resume(&terminal))
            .unwrap_err()
            .contains("Only agent conversations"));
        let running = record("agent", "running");
        assert!(host
            .request("session.reconnect", &resume(&running))
            .unwrap_err()
            .contains("still running"));
        // The exit observer releases the process entry before publishing the final status.
        let stopping = record("agent", "stopping");
        let reconnect = host.request("session.reconnect", &resume(&stopping));
        let status = host
            .registry
            .lock()
            .unwrap()
            .sessions()
            .unwrap()
            .into_iter()
            .find(|s| s.id == stopping)
            .unwrap()
            .status;
        assert_eq!(
            status, "stopping",
            "reconnect must wait for the old engine's final state, got {reconnect:?}"
        );
        assert!(reconnect.unwrap_err().contains("still running"));
        let stopped = record("agent", "interrupted");
        assert!(host
            .request(
                "session.reconnect",
                &json!({"id": stopped, "history": {"id": "sess_ok", "mode": "fork"}})
            )
            .unwrap_err()
            .contains("own session"));
        assert!(host
            .request(
                "session.reconnect",
                &json!({"id": stopped, "history": {"id": "../outside", "mode": "resume"}})
            )
            .unwrap_err()
            .contains("Invalid recorded session identity"));
        // Every refusal leaves the conversation as it was.
        let sessions = host.registry.lock().unwrap().sessions().unwrap();
        assert_eq!(
            sessions.iter().find(|s| s.id == stopped).unwrap().status,
            "interrupted"
        );
        drop(host);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_sent_or_queued_prompt_is_what_names_a_conversation() {
        assert_eq!(
            sent_prompt(&json!({"type":"user_message","payload":{"content":"Fix it"}})),
            Some("Fix it")
        );
        assert_eq!(
            sent_prompt(
                &json!({"type":"user_message","payload":{"content":"refined","journalRaw":"original"}})
            ),
            Some("original"),
            "the user's own words, not the refinement"
        );
        assert_eq!(
            sent_prompt(&json!({"type":"queue.add","payload":{"text":"Later"}})),
            Some("Later")
        );
        assert_eq!(sent_prompt(&json!({"type":"abort","payload":{}})), None);
    }

    #[test]
    fn history_identity_refuses_paths_and_unknown_modes_before_launch() {
        assert!(history_source(&json!({})).unwrap().is_none());
        assert_eq!(
            history_source(&json!({"history":{"id":"2026-10-27/sess_01ABC","mode":"fork"}}))
                .unwrap(),
            Some(("2026-10-27/sess_01ABC", true))
        );
        assert_eq!(
            history_source(&json!({"history":{"id":"sess_legacy","mode":"resume"}})).unwrap(),
            Some(("sess_legacy", false))
        );
        for id in [
            "",
            "../foreign",
            "/absolute",
            "C:/foreign",
            "date//id",
            "date\\id",
            "--continue",
        ] {
            assert!(
                history_source(&json!({"history":{"id":id,"mode":"resume"}})).is_err(),
                "{id}"
            );
        }
        assert!(history_source(&json!({"history":{"id":"sess_ok","mode":"new"}})).is_err());
    }

    #[test]
    fn session_write_does_not_hold_live_lock_across_writer_io() {
        struct GatedWriter {
            entered: std::sync::mpsc::SyncSender<()>,
            release: std::sync::mpsc::Receiver<()>,
        }
        impl std::io::Write for GatedWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.entered.send(()).unwrap();
                self.release.recv().map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::BrokenPipe, "test writer released")
                })?;
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let dir = std::env::temp_dir().join(format!("ws-f218-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = HostState::new(&dir).unwrap();
        let (entered, writing) = std::sync::mpsc::sync_channel(1);
        let (release, resume) = std::sync::mpsc::sync_channel(1);
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(GatedWriter {
            entered,
            release: resume,
        })));
        host.live.lock().unwrap().insert(
            "t1".into(),
            LiveSession {
                master: None,
                writer: Some(writer),
                killer: None,
                agent_pid: None,
                engine: None,
                stop_requested: false,
            },
        );
        let host_bg = Arc::clone(&host);
        let handle = thread::spawn(move || {
            host_bg.request("session.write", &json!({"id": "t1", "data": "hello"}))
        });
        writing.recv_timeout(Duration::from_secs(5)).unwrap();
        let live_try = host.live.try_lock();
        let is_contended = matches!(live_try, Err(std::sync::TryLockError::WouldBlock));
        drop(live_try);
        release.send(()).unwrap();
        handle.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            !is_contended,
            "session.write held HostState::live lock while blocked on PTY writer"
        );
    }
}
fn engine_command(adopted: Option<&Path>) -> Result<Command> {
    if let (Ok(bun), Ok(entry)) = (
        std::env::var("WRONGSTACK_DESKTOP_BUN"),
        std::env::var("WRONGSTACK_DESKTOP_ENTRY"),
    ) {
        if !Path::new(&bun).is_absolute() || !Path::new(&entry).is_file() {
            return Err("Invalid development engine paths; build the workspace first".into());
        }
        let mut c = Command::new(bun);
        c.arg(entry);
        return Ok(c);
    }
    let path = std::env::var_os("WRONGSTACK_DESKTOP_ENGINE")
        .map(PathBuf::from)
        .or_else(|| adopted.map(Path::to_path_buf))
        .ok_or(
            "No desktop engine was found. Reinstall WrongStack Desktop, start the application \
             from its portable folder next to the bundled wrongstack-engine, or run \
             bun run desktop:v2 for development.",
        )?;
    if !path.is_absolute() || !path.is_file() {
        return Err("Invalid desktop engine executable path".into());
    }
    Ok(Command::new(path))
}

pub fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}
pub fn field<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .ok_or_else(|| format!("Missing string: {key}"))
}
fn dimension(p: &Value, key: &str) -> Result<u16> {
    let n = p[key].as_u64().ok_or("Invalid terminal size")?;
    if !(1..=500).contains(&n) {
        return Err("Terminal size must be between 1 and 500".into());
    }
    Ok(n as u16)
}
