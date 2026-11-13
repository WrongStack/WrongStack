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

pub struct LiveSession {
    pub master: Option<Box<dyn MasterPty + Send>>,
    pub writer: Option<SharedWriter>,
    pub killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    pub agent_pid: Option<u32>,
    pub engine: Option<Arc<Engine>>,
}
pub struct HostState {
    pub(crate) project_runtimes: Mutex<HashMap<String, crate::project_runtime::ProjectRuntime>>,
    pub registry: Mutex<Registry>,
    pub live: Mutex<HashMap<String, LiveSession>>,
    pub dir: PathBuf,
    /// The engine a later launch handed over when this host was started without one.
    adopted_engine: Mutex<Option<PathBuf>>,
    /// Booted engines waiting to become a conversation, newest last.
    spares: Mutex<Vec<SpareEngine>>,
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

/// The claim a spare engine waits for: a new conversation, or a recorded one to resume.
fn spare_claim(history: Option<(&str, bool)>) -> Value {
    match history {
        Some((source, fork)) => json!({"resume": source, "fork": fork}),
        None => json!({}),
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
            dir: dir.into(),
            adopted_engine: Mutex::new(None),
            spares: Mutex::new(Vec::new()),
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
            "session.read" => self.read(field(p, "id")?, p["offset"].as_u64()),
            "session.write" => {
                let mut live = self.live.lock().map_err(err)?;
                let writer = live
                    .get_mut(field(p, "id")?)
                    .and_then(|s| s.writer.as_mut())
                    .ok_or("Terminal is not running")?;
                let mut writer = writer.lock().map_err(err)?;
                writer
                    .write_all(field(p, "data")?.as_bytes())
                    .map_err(err)?;
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
                let live = self.live.lock().map_err(err)?;
                live.get(field(p, "id")?)
                    .and_then(|s| s.engine.as_ref())
                    .ok_or("Engine is still starting")?
                    .send(p["message"].clone())
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
                let engine = self
                    .live
                    .lock()
                    .map_err(err)?
                    .get(field(p, "id")?)
                    .and_then(|s| s.engine.clone())
                    .ok_or("Engine is still starting")?;
                engine.http(
                    field(p, "method")?,
                    field(p, "resource")?,
                    &p["body"],
                    p["operationId"].as_str(),
                )
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
    fn open(self: &Arc<Self>, p: &Value) -> Result<Value> {
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
        let title = p["title"]
            .as_str()
            .unwrap_or(if kind == "agent" {
                "Agent session"
            } else {
                "Terminal"
            })
            .trim();
        if title.is_empty() || title.len() > 200 {
            return Err("Title must contain 1–200 bytes".into());
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
        };
        self.registry.lock().map_err(err)?.insert(&s)?;
        let result = if kind == "terminal" {
            self.open_terminal(&s)
        } else if let Some(spare) = &spare {
            // The record exists before the claim: the engine may answer at once, and its
            // "running" state must find the conversation to update.
            self.claim_spare(spare, history).inspect_err(|_| {
                let _ = self.kill(&spare.runtime_id);
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
        if kind == "agent" {
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
        let (claim, _) = self.spare_files(&runtime_id);
        let next = claim.with_extension("json.tmp");
        let asked = std::fs::write(&next, br#"{"stop":true}"#)
            .and_then(|()| std::fs::rename(&next, &claim))
            .is_ok();
        let host = Arc::clone(self);
        thread::spawn(move || {
            if asked {
                thread::sleep(SPARE_STOP_GRACE);
            }
            let running = host
                .live
                .lock()
                .map(|live| live.contains_key(&runtime_id))
                .unwrap_or(false);
            if running {
                let _ = host.kill(&runtime_id);
            }
        });
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
    /// Starts a spare for `workdir` in the background, after [`SPARE_REFILL_DELAY`], unless one
    /// is waiting there, stopping the oldest spares beyond [`SPARE_LIMIT`].
    fn refill_spare(self: &Arc<Self>, workdir: String) {
        let host = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(SPARE_REFILL_DELAY);
            let Ok(engine) = host.engine_command().map(|c| command_identity(&c)) else {
                return;
            };
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
            let Ok(claimed) = host.spawn_engine(&runtime_id, &workdir, true, None, true) else {
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
        });
    }
    /// Starts a stopped agent conversation's engine again on its own record and journal,
    /// resuming the WrongStack session it recorded: the conversation keeps its id, its tab and
    /// its history, and its journal continues where the stopped engine left it.
    fn reconnect(self: &Arc<Self>, p: &Value) -> Result<Value> {
        let id = field(p, "id")?;
        let (history, fork) = history_source(p)?.ok_or("Missing history source")?;
        if fork {
            return Err("Reconnecting resumes the conversation's own session".into());
        }
        let session = self
            .registry
            .lock()
            .map_err(err)?
            .sessions()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or("Unknown session")?;
        if session.kind != "agent" {
            return Err("Only agent conversations have an engine to reconnect".into());
        }
        if session.status == "running"
            || session.status == "starting"
            || self.live.lock().map_err(err)?.contains_key(id)
        {
            return Err("This conversation's engine is still running".into());
        }
        self.registry
            .lock()
            .map_err(err)?
            .state(id, "starting", None, None)?;
        if let Err(e) =
            self.start_engine_with_history(id, &session.workdir, true, Some((history, false)))
        {
            self.registry
                .lock()
                .map_err(err)?
                .state(id, "error", None, Some(&e))?;
            return Err(e);
        }
        Ok(json!({ "id": id }))
    }
    fn log_reader(
        self: &Arc<Self>,
        id: String,
        mut reader: Box<dyn Read + Send>,
        sink: Arc<Mutex<Transcript>>,
        startup: Option<SharedWriter>,
    ) -> Result<()> {
        let host = Arc::clone(self);
        thread::spawn(move || {
            let mut buffer = [0; 32768];
            let mut handshake = CursorHandshake::default();
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
                    if !bytes.is_empty() {
                        sink.lock()
                            .map_err(|e| std::io::Error::other(e.to_string()))?
                            .append(&bytes)?;
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                if let Ok(r) = host.registry.lock() {
                    let _ = r.state(&id, "error", None, Some(&format!("Transcript IO: {e}")));
                }
            }
        });
        Ok(())
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
        cmd.cwd(&s.workdir);
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
        self.log_reader(
            s.id.clone(),
            reader,
            sink,
            if cfg!(windows) {
                Some(Arc::clone(&writer))
            } else {
                None
            },
        )?;
        self.live.lock().map_err(err)?.insert(
            s.id.clone(),
            LiveSession {
                master: Some(pair.master),
                writer: Some(writer),
                killer: Some(killer),
                agent_pid: process_id,
                engine: None,
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
    ) -> Result<Arc<Mutex<Option<std::time::Instant>>>> {
        let reservation = TcpListener::bind("127.0.0.1:0").map_err(err)?;
        let port = reservation.local_addr().map_err(err)?.port();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut command = self.engine_command()?;
        let (claim_path, ready_path) = self.spare_files(runtime_id);
        let stop_path = self.stop_file(runtime_id);
        let _ = std::fs::remove_file(&stop_path);
        command.env("WRONGSTACK_DESKTOP_STOP_FILE", &stop_path);
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
        drop(reservation);
        let mut child = command.spawn().map_err(err)?;
        let sink = Transcript::open(&self.dir.join("transcripts"), runtime_id)?;
        self.log_reader(
            runtime_id.to_owned(),
            Box::new(child.stdout.take().ok_or("Missing engine stdout")?),
            Arc::clone(&sink),
            None,
        )?;
        // Separate streams avoid corrupting concurrent JSONL/byte writes to one transcript.
        self.log_reader(
            runtime_id.to_owned(),
            Box::new(child.stderr.take().ok_or("Missing engine stderr")?),
            sink,
            None,
        )?;
        self.live.lock().map_err(err)?.insert(
            runtime_id.to_owned(),
            LiveSession {
                master: None,
                writer: None,
                killer: None,
                agent_pid: Some(child.id()),
                engine: None,
            },
        );
        let host = Arc::clone(self);
        let id = runtime_id.to_owned();
        // A spare answers through the readiness file too, once it is claimed.
        let restoring = history.is_some() || spare;
        let watched = Arc::clone(&claimed);
        thread::spawn(move || {
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
            loop {
                match child.try_wait() {
                    Ok(Some(_)) if watched.lock().map(|at| at.is_none()).unwrap_or(false) => {
                        // An unclaimed spare stopped (replaced, or the engine exited): it was
                        // never a conversation, so it leaves nothing behind.
                        host.live.lock().unwrap().remove(&id);
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
                    Ok(Some(code)) => {
                        host.live.lock().unwrap().remove(&id);
                        let restore_error = if restoring {
                            std::fs::read(&ready_path)
                                .ok()
                                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                                .and_then(|value| value["error"].as_str().map(str::to_owned))
                        } else {
                            None
                        };
                        let _ = host.publish_runtime_state(
                            &id,
                            if code.success() { "stopped" } else { "error" },
                            code.code(),
                            if code.success() {
                                None
                            } else {
                                Some(
                                    restore_error
                                        .as_deref()
                                        .unwrap_or("WrongStack engine exited; inspect engine logs"),
                                )
                            },
                        );
                        break;
                    }
                    Err(e) => {
                        let _ =
                            host.publish_runtime_state(&id, "error", None, Some(&e.to_string()));
                        break;
                    }
                    _ => {}
                }
                if !ready {
                    if restoring {
                        let restored = std::fs::read(&ready_path)
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                        if let Some(message) =
                            restored.as_ref().and_then(|value| value["error"].as_str())
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                            host.live.lock().unwrap().remove(&id);
                            let _ = host.publish_runtime_state(&id, "error", None, Some(message));
                            break;
                        }
                        if restored
                            .as_ref()
                            .and_then(|value| value["sessionId"].as_str())
                            .is_none()
                        {
                            if expired() {
                                let _ = child.kill();
                                let _ = child.wait();
                                host.live.lock().unwrap().remove(&id);
                                let _ = host.publish_runtime_state(
                                    &id,
                                    "error",
                                    None,
                                    Some("Recorded conversation startup timed out"),
                                );
                                break;
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
                            .join(format!("{id}.events.jsonl")),
                        bind_session,
                    ) {
                        if let Some(live) = host.live.lock().unwrap().get_mut(&id) {
                            live.engine = Some(engine);
                        }
                        ready = true;
                        let _ = host.publish_runtime_state(&id, "running", None, None);
                    } else if expired() {
                        let _ = child.kill();
                        let _ = child.wait();
                        host.live.lock().unwrap().remove(&id);
                        let _ = host.publish_runtime_state(
                            &id,
                            "error",
                            None,
                            Some("WrongStack engine startup timed out after 90 seconds"),
                        );
                        break;
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
            // A stop request the engine never read must not stop the next engine on this id.
            let _ = std::fs::remove_file(host.stop_file(&id));
        });
        Ok(claimed)
    }
    /// The file an engine watches for a graceful stop request (`WRONGSTACK_DESKTOP_STOP_FILE`).
    fn stop_file(&self, runtime_id: &str) -> PathBuf {
        self.dir
            .join("transcripts")
            .join(format!("{runtime_id}.stop"))
    }
    /// Stops a session. An engine is asked first, through its stop file, so it runs its
    /// graceful shutdown: every conversation journal it holds gets its `session_end` (a killed
    /// one read as a crash on the next launch) and an unused boot session is closed as a
    /// strictly empty journal the empty-session sweep can remove. One still running after
    /// [`ENGINE_STOP_GRACE`] is stopped hard; terminals are stopped hard at once.
    fn stop(self: &Arc<Self>, id: &str) -> Result<Value> {
        let engine_pid = {
            let live = self.live.lock().map_err(err)?;
            let session = live.get(id).ok_or("Session is not running")?;
            session.agent_pid.filter(|_| session.master.is_none())
        };
        let Some(pid) = engine_pid else {
            return self.kill(id);
        };
        if std::fs::write(self.stop_file(id), b"").is_err() {
            return self.kill(id);
        }
        // The shutdown takes seconds: the conversation shows as stopping (no longer live, not
        // yet offered for reconnect) until its engine exits.
        let _ = self.publish_runtime_state(id, "stopping", None, None);
        let host = Arc::clone(self);
        let id = id.to_owned();
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + ENGINE_STOP_GRACE;
            // Only this engine: a reconnect may start another one on the same id meanwhile.
            let running = || {
                host.live
                    .lock()
                    .map(|live| live.get(&id).and_then(|s| s.agent_pid) == Some(pid))
                    .unwrap_or(false)
            };
            while running() {
                if std::time::Instant::now() > deadline {
                    let _ = host.kill(&id);
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(Value::Null)
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
        if self.live.lock().map_err(err)?.contains_key(id) {
            self.stop(id)?;
            // The exit watcher drops the live entry and records the exit; waiting for it means
            // nothing writes to the transcript after it is deleted. A graceful stop may take up
            // to its grace before the hard stop.
            let deadline = std::time::Instant::now() + ENGINE_STOP_GRACE + Duration::from_secs(10);
            while self.live.lock().map_err(err)?.contains_key(id) {
                if std::time::Instant::now() > deadline {
                    return Err("The session did not stop; try again".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
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
    fn kill(&self, id: &str) -> Result<Value> {
        let mut live = self.live.lock().map_err(err)?;
        let session = live.get_mut(id).ok_or("Session is not running")?;
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
            started: std::time::Instant::now(),
        };
        let idle = || LiveSession {
            master: None,
            writer: None,
            killer: None,
            agent_pid: None,
            engine: None,
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
            },
        );
        host.stop("engine").unwrap();
        assert!(
            host.stop_file("engine").exists(),
            "the engine is asked to stop gracefully before any hard stop"
        );
        // The engine "exits": the grace thread sees it gone and does nothing more.
        host.live.lock().unwrap().remove("engine");
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
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

    #[test]
    fn reconnect_refuses_unknown_terminal_running_and_forked_conversations() {
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
