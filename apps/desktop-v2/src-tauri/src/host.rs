//! Authenticated, non-HTTP loopback protocol. The host outlives every UI window.
use crate::{
    err,
    sessions::{hide, HostState},
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const REQUEST_FRAME_BYTES: u64 = 20 * 1024 * 1024;
const RESPONSE_FRAME_BYTES: u64 = 24 * 1024 * 1024;
fn read_frame(reader: impl Read, limit: u64) -> Result<String> {
    let mut text = String::new();
    BufReader::new(reader)
        .take(limit + 1)
        .read_line(&mut text)
        .map_err(err)?;
    if text.len() as u64 > limit || !text.ends_with('\n') {
        return Err("Native transport frame exceeds its size limit or is incomplete".into());
    }
    Ok(text)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}
#[derive(Clone)]
pub struct Client {
    pub endpoint: Endpoint,
}
pub fn engine_build() -> &'static str {
    option_env!("WRONGSTACK_DESKTOP_ENGINE_ID").unwrap_or("development")
}
pub fn can_share_services(capabilities: &Value) -> bool {
    capabilities["projectApi"] == 1 && capabilities["engineBuild"].as_str() == Some(engine_build())
}
#[cfg(test)]
mod service_version_tests {
    use super::*;
    #[test]
    fn native_client_preserves_fractional_revision_tokens_in_both_directions() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let expected = "1793127358526.4639".parse::<f64>().unwrap();
        let peer = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let request = read_frame(stream.try_clone().unwrap(), REQUEST_FRAME_BYTES).unwrap();
            assert!(request.contains("1793127358526.4639"));
            stream
                .write_all(b"{\"result\":{\"mtimeMs\":1793127358526.4639,\"control\":42}}\n")
                .unwrap();
        });
        let client = Client {
            endpoint: Endpoint {
                port,
                token: "fixture".into(),
                pid: 0,
            },
        };
        let response = client
            .call("profile.send", json!({"baseMtimeMs":expected}))
            .unwrap();
        peer.join().unwrap();
        assert_eq!(response["control"], 42);
        assert_eq!(
            response["mtimeMs"].as_f64().unwrap().to_bits(),
            expected.to_bits()
        );
    }
    #[test]
    fn does_not_reuse_project_services_from_a_different_engine_build() {
        assert!(can_share_services(
            &json!({"projectApi":1,"engineBuild":engine_build()})
        ));
        assert!(!can_share_services(&json!({"projectApi":1})));
        assert!(!can_share_services(
            &json!({"projectApi":1,"engineBuild":"previous-engine"})
        ));
    }
    #[test]
    fn accepts_attachment_frames_and_refuses_over_budget_or_incomplete_frames() {
        assert_eq!(
            read_frame(&b"{}\n"[..], REQUEST_FRAME_BYTES).unwrap(),
            "{}\n"
        );
        let attachment = format!("{{\"data\":\"{}\"}}\n", "x".repeat(1024 * 1024));
        assert!(
            read_frame(attachment.as_bytes(), REQUEST_FRAME_BYTES).is_ok(),
            "An ordinary attachment must fit through the real native frame reader"
        );
        assert!(read_frame(&b"12345\n"[..], 5).is_err());
        assert!(read_frame(&b"{}"[..], REQUEST_FRAME_BYTES).is_err());
    }
}
pub fn data_dir() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("WRONGSTACK_DESKTOP_DATA") {
        return Ok(PathBuf::from(p));
    }
    let base = std::env::var_os(if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "HOME"
    })
    .ok_or("Cannot locate user data directory")?;
    Ok(PathBuf::from(base).join("WrongStack/desktop-v2-native"))
}
pub fn protect_dir(dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(err)?;
    #[cfg(windows)]
    {
        // Resolve the current SID, not a locale-dependent account name.
        let mut who = Command::new("whoami");
        who.args(["/user", "/fo", "csv", "/nh"]);
        hide(&mut who);
        let out = who.output().map_err(err)?;
        if !out.status.success() {
            return Err("Cannot resolve current Windows identity".into());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let sid = text
            .split(',')
            .nth(1)
            .ok_or("Missing Windows SID")?
            .trim()
            .trim_matches('"');
        if !sid.starts_with("S-1-") {
            return Err("Invalid Windows SID".into());
        }
        let mut acl = Command::new("icacls");
        acl.arg(dir)
            .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F")]);
        hide(&mut acl);
        if !acl.output().map_err(err)?.status.success() {
            return Err("Cannot restrict session host data permissions".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(())
}
impl Client {
    pub fn connect(engine: Option<&Path>) -> Result<Self> {
        let dir = data_dir()?;
        Self::connect_at(engine, &dir)
    }
    pub fn connect_at(engine: Option<&Path>, dir: &Path) -> Result<Self> {
        protect_dir(&dir)?;
        if let Ok(c) = Self::load(&dir) {
            c.hand_over_engine(engine)?;
            return Ok(c);
        }
        // OS file lock prevents two concurrently launched desktop windows from electing two hosts.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("host.lock"))
            .map_err(err)?;
        lock.lock().map_err(err)?;
        if let Ok(c) = Self::load(&dir) {
            return Ok(c);
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("host.log"))
            .map_err(err)?;
        // A persistent host must not keep the UI executable locked on Windows:
        // dev rebuilds and future updates replace that executable independently.
        let host_bin = dir.join("hosts").join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&host_bin).map_err(err)?;
        let host_exe = host_bin.join(if cfg!(windows) {
            "wrongstack-session-host.exe"
        } else {
            "wrongstack-session-host"
        });
        std::fs::copy(std::env::current_exe().map_err(err)?, &host_exe).map_err(err)?;
        let mut command = Command::new(host_exe);
        if let Some(engine) = engine {
            command
                .env("WRONGSTACK_DESKTOP_ENGINE", engine)
                .env_remove("WRONGSTACK_DESKTOP_BUN")
                .env_remove("WRONGSTACK_DESKTOP_ENTRY");
        }
        command
            .arg("--session-host")
            .env("WRONGSTACK_DESKTOP_DATA", dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(err)?))
            .stderr(Stdio::from(log));
        hide(&mut command);
        let mut child = command.spawn().map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(c) = Self::load(&dir) {
                return Ok(c);
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                return Err(format!(
                    "Session host exited ({status}); inspect {}",
                    dir.join("host.log").display()
                ));
            }
            if Instant::now() > deadline {
                return Err("Session host startup timed out".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    /// A running host that was started without an engine takes this launch's engine. Hosts
    /// that predate the `engine` field report nothing and are left as they are.
    fn hand_over_engine(&self, engine: Option<&Path>) -> Result<()> {
        let Some(engine) = engine else {
            return Ok(());
        };
        if self.call("ping", json!({}))?["engine"] == false {
            self.call("engine.adopt", json!({"path": engine.to_string_lossy()}))?;
        }
        Ok(())
    }
    fn load(dir: &std::path::Path) -> Result<Self> {
        let endpoint: Endpoint =
            serde_json::from_reader(File::open(dir.join("host.json")).map_err(err)?)
                .map_err(err)?;
        let c = Self { endpoint };
        let pong = c.call("ping", json!({}))?;
        if pong["protocol"] != 1 || pong["pid"] != c.endpoint.pid {
            return Err("Session host protocol mismatch".into());
        }
        Ok(c)
    }
    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        let request = serde_json::to_vec(
            &json!({"token":self.endpoint.token,"method":method,"params":params}),
        )
        .map_err(err)?;
        if request.len() as u64 + 1 > REQUEST_FRAME_BYTES {
            return Err(
                "This request exceeds the native attachment limit. Your draft is kept.".into(),
            );
        }
        // Existing human hosts stay alive during updates. Refuse oversized sends
        // before touching a legacy 1 MiB connection, rather than dropping the draft.
        if request.len() > 1024 * 1024 && method != "ping" {
            let caps = self.call("ping", json!({}))?;
            if request.len() as u64 + 1 > caps["requestFrameBytes"].as_u64().unwrap_or(1024 * 1024)
            {
                return Err("This session is attached to an older host with a 1 MB limit. Keep the draft and open a new session on the current desktop build to send these files.".into());
            }
        }
        let mut stream = TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", self.endpoint.port)
                .parse()
                .map_err(err)?,
            Duration::from_secs(2),
        )
        .map_err(err)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(err)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(err)?;
        stream.write_all(&request).map_err(err)?;
        stream.write_all(b"\n").map_err(err)?;
        let text = read_frame(stream, RESPONSE_FRAME_BYTES)?;
        let reply: Value = serde_json::from_str(&text).map_err(err)?;
        if let Some(error) = reply["error"].as_str() {
            return Err(error.into());
        }
        Ok(reply["result"].clone())
    }
}
pub fn serve() -> Result<()> {
    let dir = data_dir()?;
    protect_dir(&dir)?;
    let ownership = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("owner.lock"))
        .map_err(err)?;
    ownership
        .try_lock()
        .map_err(|_| "Session host already running".to_string())?;
    let state = HostState::new(&dir)?;
    let server = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let endpoint = Endpoint {
        port: server.local_addr().map_err(err)?.port(),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        pid: std::process::id(),
    };
    let pending = dir.join("host.pending.json");
    serde_json::to_writer(File::create(&pending).map_err(err)?, &endpoint).map_err(err)?;
    // Windows rename does not replace existing paths.
    if dir.join("host.json").exists() {
        std::fs::remove_file(dir.join("host.json")).map_err(err)?;
    }
    std::fs::rename(pending, dir.join("host.json")).map_err(err)?;
    // Bound both running requests and the queue; renderer polling reuses OS threads.
    let token = endpoint.token.clone();
    let pool = crate::request_pool::RequestPool::new(move |stream| {
        let _ = handle(stream, &token, &state);
    })?;
    for stream in server.incoming() {
        let stream = stream.map_err(err)?;
        pool.submit(stream);
    }
    Ok(())
}
fn handle(mut stream: TcpStream, token: &str, state: &Arc<HostState>) -> Result<()> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(err)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(err)?;
    let text = read_frame(stream.try_clone().map_err(err)?, REQUEST_FRAME_BYTES)?;
    let request: Value = serde_json::from_str(&text).map_err(err)?;
    if request["token"].as_str() != Some(token) {
        return Err("Unauthorized".into());
    }
    let response = match state.request(
        request["method"].as_str().ok_or("Missing method")?,
        &request["params"],
    ) {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error}),
    };
    serde_json::to_writer(&mut stream, &response).map_err(err)?;
    stream.write_all(b"\n").map_err(err)?;
    Ok(())
}
