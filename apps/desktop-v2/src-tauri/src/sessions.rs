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
        }))
    }
    pub fn request(self: &Arc<Self>, method: &str, p: &Value) -> Result<Value> {
        match method {
            "ping" => Ok(
                json!({"protocol":1,"pid":std::process::id(),"projectApi":1,"engineBuild":crate::host::engine_build(),"requestFrameBytes":crate::host::REQUEST_FRAME_BYTES}),
            ),
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
                self.project_events(field(p, "projectId")?, p["offset"].as_u64().unwrap_or(0))
            }
            "project.send" => self.project_send(field(p, "projectId")?, p["message"].clone()),
            "project.http" => self.project_http(field(p, "projectId")?, p),
            "profile.open" => self.open_profile_runtime(p["retry"].as_bool().unwrap_or(false)),
            "profile.status" => self.runtime_status("@profile"),
            "profile.events" => self.project_events("@profile", p["offset"].as_u64().unwrap_or(0)),
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
            "session.kill" => self.kill(field(p, "id")?),
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
        let s = Session {
            id: Uuid::new_v4().to_string(),
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
        Ok(json!(s))
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
        let reservation = TcpListener::bind("127.0.0.1:0").map_err(err)?;
        let port = reservation.local_addr().map_err(err)?.port();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut command = engine_command()?;
        let ready_path = self
            .dir
            .join("transcripts")
            .join(format!("{runtime_id}.restore.json"));
        if let Some((id, fork)) = history {
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let disabled_frontend = self.dir.join("frontend-disabled");
        std::fs::create_dir_all(&disabled_frontend).map_err(err)?;
        command.env("WRONGSTACK_DESKTOP_EMPTY_DIST", disabled_frontend);
        hide(&mut command);
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
        let restoring = history.is_some();
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(90);
            let mut ready = false;
            loop {
                match child.try_wait() {
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
                            if std::time::Instant::now() > deadline {
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
                            thread::sleep(Duration::from_millis(250));
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
                    } else if std::time::Instant::now() > deadline {
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
                thread::sleep(Duration::from_millis(250));
            }
        });
        Ok(())
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
                let mut cmd = Command::new("taskkill");
                cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
                hide(&mut cmd);
                if !cmd.status().map_err(err)?.success() {
                    return Err("Could not stop engine process tree".into());
                }
            }
            #[cfg(not(windows))]
            {
                Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
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
fn engine_command() -> Result<Command> {
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
        .ok_or("Desktop engine is not bundled yet. Launch with bun run desktop:v2.")?;
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
