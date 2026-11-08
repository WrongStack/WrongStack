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
/// The bundled runtime's file name. Installers place it beside the application executable
/// (Windows install folder, `/usr/bin` for deb/rpm, `Contents/MacOS` in the macOS bundle).
pub const ENGINE_FILE_NAME: &str = if cfg!(windows) {
    "wrongstack-engine.exe"
} else {
    "wrongstack-engine"
};
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
    fn engines_run_from_a_private_copy_so_installers_can_replace_the_bundled_one() {
        let dir = std::env::temp_dir().join(format!("desktop-engine-stage-{}", Uuid::new_v4()));
        let install = dir.join("install");
        std::fs::create_dir_all(&install).unwrap();
        let bundled = install.join(ENGINE_FILE_NAME);
        std::fs::write(&bundled, b"engine-v1").unwrap();
        let data = dir.join("data");
        let adopted = stage_engine(&data, &bundled).unwrap();
        let (_, started) = stage_session_host(&data, Some(&bundled)).unwrap();
        let started = started.unwrap();
        if cfg!(windows) {
            for (staged, kind) in [(&adopted, "engines"), (&started, "hosts")] {
                assert!(staged.starts_with(data.join(kind)), "{}", staged.display());
                assert_eq!(staged.file_name().unwrap(), ENGINE_FILE_NAME);
                assert_eq!(std::fs::read(staged).unwrap(), b"engine-v1");
            }
            assert!(started
                .parent()
                .unwrap()
                .join(SESSION_HOST_FILE_NAME)
                .is_file());
        } else {
            assert_eq!(adopted, bundled);
            assert_eq!(started, bundled);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn a_new_host_removes_the_copies_of_exited_hosts_and_keeps_live_ones() {
        let data = std::env::temp_dir().join(format!("desktop-host-prune-{}", Uuid::new_v4()));
        let bin = |name: &str| {
            let bin = data.join("hosts").join(name);
            std::fs::create_dir_all(&bin).unwrap();
            bin
        };
        // A live host: Windows will not delete its running executable.
        let live = bin("live");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        std::fs::copy(system.join("PING.EXE"), live.join(SESSION_HOST_FILE_NAME)).unwrap();
        std::fs::write(live.join(ENGINE_FILE_NAME), b"engine").unwrap();
        let mut running = Command::new(live.join(SESSION_HOST_FILE_NAME))
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let exited = bin("exited");
        std::fs::write(exited.join(SESSION_HOST_FILE_NAME), b"host").unwrap();
        std::fs::write(exited.join(ENGINE_FILE_NAME), b"engine").unwrap();
        // Left behind when an exited host's engine was still running at the last launch.
        let orphaned = bin("orphaned");
        std::fs::write(orphaned.join(ENGINE_FILE_NAME), b"engine").unwrap();
        let adopted = stage_engine(&data, &live.join(ENGINE_FILE_NAME)).unwrap();

        let (host, _) = stage_session_host(&data, None).unwrap();
        let _ = running.kill();
        let _ = running.wait();
        assert!(live.join(SESSION_HOST_FILE_NAME).is_file());
        assert!(live.join(ENGINE_FILE_NAME).is_file());
        assert!(!exited.exists());
        assert!(!orphaned.exists());
        assert!(
            adopted.is_file(),
            "an engine handed to a running host stays"
        );
        assert!(host.is_file());
        std::fs::remove_dir_all(data).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn a_new_build_also_cleans_the_folders_of_earlier_builds_unless_one_is_staging() {
        let data = std::env::temp_dir().join(format!("desktop-sibling-prune-{}", Uuid::new_v4()));
        let build = |name: &str| data.join(COMPANION_ROOT).join(name);
        let host_copy = |dir: &Path, name: &str, live: bool| {
            let bin = dir.join("hosts").join(name);
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(dir.join("host.lock"), b"").unwrap();
            let exe = bin.join(SESSION_HOST_FILE_NAME);
            if live {
                let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
                std::fs::copy(system.join("System32").join("PING.EXE"), &exe).unwrap();
                return Some(
                    Command::new(&exe)
                        .args(["-n", "30", "127.0.0.1"])
                        .stdout(Stdio::null())
                        .spawn()
                        .unwrap(),
                );
            }
            std::fs::write(&exe, b"host").unwrap();
            None
        };
        host_copy(&data, "main-exited", false);
        host_copy(&build("old"), "old-exited", false);
        let mut running = host_copy(&build("older"), "older-live", true).unwrap();
        host_copy(&build("staging"), "staging-fresh", false);
        let staging_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(build("staging").join("host.lock"))
            .unwrap();
        staging_lock.lock().unwrap();
        let current = build("current");
        std::fs::create_dir_all(&current).unwrap();

        let (host, _) = stage_session_host(&current, None).unwrap();
        let _ = running.kill();
        let _ = running.wait();
        drop(staging_lock);
        assert!(!data.join("hosts").join("main-exited").exists());
        assert!(!build("old").join("hosts").join("old-exited").exists());
        assert!(build("older").join("hosts").join("older-live").is_dir());
        assert!(build("staging")
            .join("hosts")
            .join("staging-fresh")
            .is_dir());
        assert!(host.is_file());
        std::fs::remove_dir_all(data).unwrap();
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
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    Ok(data_root_for(std::env::consts::OS, var)?.join("WrongStack/desktop-v2-native"))
}
/// The per-user application data root each OS expects: `%LOCALAPPDATA%` on Windows,
/// `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` (or `~/.local/share`) elsewhere.
fn data_root_for(os: &str, var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Result<PathBuf> {
    if os == "windows" {
        return var("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "Cannot locate user data directory (LOCALAPPDATA)".into());
    }
    if os != "macos" {
        // The XDG spec ignores a relative XDG_DATA_HOME.
        if let Some(xdg) = var("XDG_DATA_HOME").map(PathBuf::from) {
            if xdg.has_root() {
                return Ok(xdg);
            }
        }
    }
    let home = PathBuf::from(var("HOME").ok_or("Cannot locate user data directory (HOME)")?);
    Ok(if os == "macos" {
        home.join("Library/Application Support")
    } else {
        home.join(".local/share")
    })
}
#[cfg(test)]
mod data_root_tests {
    use super::*;
    fn env<'a>(
        pairs: &'a [(&'a str, &'a str)],
    ) -> impl Fn(&str) -> Option<std::ffi::OsString> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.into())
        }
    }
    #[test]
    fn each_platform_uses_its_own_per_user_data_root() {
        let vars = [
            ("LOCALAPPDATA", "C:/Users/a/AppData/Local"),
            ("HOME", "/home/a"),
            ("XDG_DATA_HOME", "/data/a"),
        ];
        assert_eq!(
            data_root_for("windows", env(&vars)).unwrap(),
            PathBuf::from("C:/Users/a/AppData/Local")
        );
        assert_eq!(
            data_root_for("macos", env(&vars)).unwrap(),
            PathBuf::from("/home/a/Library/Application Support")
        );
        assert_eq!(
            data_root_for("linux", env(&vars)).unwrap(),
            PathBuf::from("/data/a")
        );
    }
    #[test]
    fn linux_falls_back_to_local_share_and_ignores_a_relative_xdg_root() {
        let relative = [("HOME", "/home/a"), ("XDG_DATA_HOME", "data")];
        assert_eq!(
            data_root_for("linux", env(&relative)).unwrap(),
            PathBuf::from("/home/a/.local/share")
        );
        assert!(data_root_for("linux", env(&[])).is_err());
        assert!(data_root_for("windows", env(&[("HOME", "/home/a")])).is_err());
    }
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
/// The executables the persistent session host, and the engines it spawns, run from.
///
/// Windows locks a running executable, so both run from a private copy: dev rebuilds and
/// installer updates can then replace the application and its bundled `wrongstack-engine.exe`
/// while sessions stay alive. Unix keeps the old inode alive for a running process, and a copy
/// taken out of a macOS bundle would carry the bundle's quarantine attribute without its
/// code-signing context, so the installed executables run directly there.
fn stage_session_host(dir: &Path, engine: Option<&Path>) -> Result<(PathBuf, Option<PathBuf>)> {
    let current = std::env::current_exe().map_err(err)?;
    if !cfg!(windows) {
        return Ok((current, engine.map(Path::to_path_buf)));
    }
    prune_exited_hosts(dir);
    prune_sibling_builds(dir);
    let host_bin = private_bin_dir(dir, "hosts")?;
    let host_exe = host_bin.join(SESSION_HOST_FILE_NAME);
    std::fs::copy(current, &host_exe).map_err(err)?;
    let engine = engine
        .map(|engine| stage_engine_in(&host_bin, engine))
        .transpose()?;
    Ok((host_exe, engine))
}
const SESSION_HOST_FILE_NAME: &str = "wrongstack-session-host.exe";
/// Removes the private copies left by hosts that have exited, so each launch does not leave
/// another copy of the application and its engine behind. Windows refuses to delete a running
/// executable: a host copy that cannot be deleted belongs to a live host, and its folder, with
/// the engine copy that host's next session starts from, is left alone. Once the host copy is
/// gone, a folder whose engine copy is still running is retried by a later launch. Runs under
/// `host.lock`, so no other launch is staging a host in this data folder meanwhile.
fn prune_exited_hosts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir.join("hosts")) else {
        return;
    };
    for entry in entries.flatten() {
        let bin = entry.path();
        let host = bin.join(SESSION_HOST_FILE_NAME);
        if host.is_file() && std::fs::remove_file(&host).is_err() {
            continue;
        }
        let _ = std::fs::remove_dir_all(&bin);
    }
}
/// Every desktop build keeps its own project-services host folder
/// (`project-services-v1/<engine build>`) beside the main one, and a build only ever stages in
/// its own, so the copies an earlier build left would never be cleaned by it. Each sibling
/// folder is pruned too, unless its `host.lock` is held: that launch is staging a host right
/// now and its fresh folder must not be taken for an exited one.
fn prune_sibling_builds(dir: &Path) {
    let base = match dir.parent() {
        Some(parent) if parent.file_name().is_some_and(|n| n == COMPANION_ROOT) => {
            parent.parent().unwrap_or(dir)
        }
        _ => dir,
    };
    let companions = std::fs::read_dir(base.join(COMPANION_ROOT))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path());
    for sibling in std::iter::once(base.to_path_buf()).chain(companions) {
        if sibling == dir {
            continue;
        }
        let Ok(lock) = OpenOptions::new()
            .read(true)
            .write(true)
            .open(sibling.join("host.lock"))
        else {
            continue;
        };
        if lock.try_lock().is_ok() {
            prune_exited_hosts(&sibling);
        }
    }
}
const COMPANION_ROOT: &str = "project-services-v1";
fn private_bin_dir(dir: &Path, kind: &str) -> Result<PathBuf> {
    let bin = dir.join(kind).join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&bin).map_err(err)?;
    Ok(bin)
}
fn stage_engine_in(bin: &Path, engine: &Path) -> Result<PathBuf> {
    let staged = bin.join(ENGINE_FILE_NAME);
    std::fs::copy(engine, &staged).map_err(err)?;
    Ok(staged)
}
/// The engine a running host adopts, staged like [`stage_session_host`] stages a new host's.
/// It lives outside `hosts/`: nothing beside it shows whether its host is still running.
/// Adoption only happens to a host started from a build output without an engine.
fn stage_engine(dir: &Path, engine: &Path) -> Result<PathBuf> {
    if !cfg!(windows) {
        return Ok(engine.to_path_buf());
    }
    stage_engine_in(&private_bin_dir(dir, "engines")?, engine)
}
impl Client {
    pub fn connect(engine: Option<&Path>) -> Result<Self> {
        let dir = data_dir()?;
        Self::connect_at(engine, &dir)
    }
    pub fn connect_at(engine: Option<&Path>, dir: &Path) -> Result<Self> {
        protect_dir(&dir)?;
        if let Ok(c) = Self::load(&dir) {
            c.hand_over_engine(engine, dir)?;
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
        let (host_exe, engine) = stage_session_host(dir, engine)?;
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
        // The host outlives the window: keep it out of the launching terminal's process group
        // so closing that terminal (or Ctrl+C) does not take every session down with it.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
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
    fn hand_over_engine(&self, engine: Option<&Path>, dir: &Path) -> Result<()> {
        let Some(engine) = engine else {
            return Ok(());
        };
        if self.call("ping", json!({}))?["engine"] == false {
            let staged = stage_engine(dir, engine)?;
            self.call("engine.adopt", json!({"path": staged.to_string_lossy()}))?;
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
