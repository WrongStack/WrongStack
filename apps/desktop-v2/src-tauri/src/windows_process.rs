//! Windows session termination; taskkill's status includes races with exiting descendants.
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::{
    collections::HashMap,
    ffi::c_void,
    io, mem,
    path::{Component, Path, Prefix},
    thread,
    time::{Duration, Instant},
};

type Handle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    name: [u16; 260],
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetProcessTimes(
        handle: Handle,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
    fn TerminateProcess(handle: Handle, exit_code: u32) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn QueryFullProcessImageNameW(
        handle: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
}
struct OwnedHandle(Handle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Process {
    handle: OwnedHandle,
    created: u64,
    pid: u32,
}
impl Process {
    fn open(pid: u32) -> crate::Result<Option<Self>> {
        Self::open_with(pid, false)
    }
    fn open_with(pid: u32, terminate: bool) -> crate::Result<Option<Self>> {
        // SAFETY: OpenProcess returns a new owned handle or null; no pointers are passed in.
        let raw = unsafe { OpenProcess(0x00101000 | u32::from(terminate), 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(87) {
                Ok(None)
            } else {
                Err(crate::err(error))
            };
        }
        let handle = OwnedHandle(raw);
        let (mut created, mut exit, mut kernel, mut user) = (
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
        );
        if unsafe { GetProcessTimes(raw, &mut created, &mut exit, &mut kernel, &mut user) } == 0 {
            return Err(crate::err(io::Error::last_os_error()));
        }
        Ok(Some(Self {
            handle,
            created: (u64::from(created.high) << 32) | u64::from(created.low),
            pid,
        }))
    }
    fn exited(&self) -> crate::Result<bool> {
        match unsafe { WaitForSingleObject(self.handle.0, 0) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(crate::err(io::Error::last_os_error())),
        }
    }
}
/// Every process as `(pid, parent, executable file name)`.
fn snapshot() -> crate::Result<Vec<(u32, u32, String)>> {
    let raw = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if raw as isize == -1 {
        return Err(crate::err(io::Error::last_os_error()));
    }
    let snapshot = OwnedHandle(raw);
    let mut entry: ProcessEntry = unsafe { mem::zeroed() };
    entry.size = mem::size_of::<ProcessEntry>() as u32;
    let mut rows = Vec::new();
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while next != 0 {
        let len = entry
            .name
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.name.len());
        rows.push((
            entry.pid,
            entry.parent,
            String::from_utf16_lossy(&entry.name[..len]),
        ));
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if io::Error::last_os_error().raw_os_error() != Some(18) {
        return Err(crate::err(io::Error::last_os_error()));
    }
    Ok(rows)
}
/// The full path of a process's executable, when it can be read.
fn image_path(pid: u32) -> Option<std::path::PathBuf> {
    let raw = unsafe { OpenProcess(0x1000, 0, pid) };
    if raw.is_null() {
        return None;
    }
    query_image(&OwnedHandle(raw))
}
fn query_image(handle: &OwnedHandle) -> Option<std::path::PathBuf> {
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: the handle is owned and buffer/size are writable for the stated capacity.
    if unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut size) } == 0 {
        return None;
    }
    use std::os::windows::ffi::OsStringExt;
    Some(std::ffi::OsString::from_wide(buffer.get(..size as usize)?).into())
}
fn image_key(path: &Path) -> String {
    let spelling = path.to_string_lossy();
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            // Windows reports both DOS paths and extended paths for the same executable.
            Prefix::VerbatimDisk(_) => spelling[4..].to_lowercase(),
            Prefix::VerbatimUNC(_, _) => format!(r"\\{}", spelling[8..].to_lowercase()),
            _ => spelling.to_lowercase(),
        },
        _ => spelling.to_lowercase(),
    }
}

#[cfg(any(feature = "desktop", test))]
mod cleanup {
    use super::*;
    use crate::engine_cleanup::OrphanEngine;
    use crate::host::ENGINE_FILE_NAME;
    use std::fs::{File, OpenOptions};
    use std::path::PathBuf;

    const HOST: &str = "wrongstack-session-host.exe";

    enum Owner {
        PrivateHost(PathBuf),
        AdoptedEngine(PathBuf),
    }

    fn owner(root: &Path, image: &Path) -> Option<Owner> {
        let bin = image.parent()?;
        let kind = bin.parent()?;
        let data = kind.parent()?;
        if !image
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case(ENGINE_FILE_NAME)
            || uuid::Uuid::parse_str(bin.file_name()?.to_str()?).is_err()
        {
            return None;
        }
        let companion = data.parent().is_some_and(|parent| {
            image_key(parent) == image_key(&root.join("project-services-v1"))
        });
        if !companion && image_key(data) != image_key(root) {
            return None;
        }
        match kind.file_name()?.to_str()?.to_ascii_lowercase().as_str() {
            "hosts" => Some(Owner::PrivateHost(bin.join(HOST))),
            "engines" => Some(Owner::AdoptedEngine(data.join("owner.lock"))),
            _ => None,
        }
    }

    fn unowned(root: &Path, image: &Path, hosts: &[Option<PathBuf>]) -> Option<Option<File>> {
        match owner(root, image)? {
            Owner::PrivateHost(host) => {
                // UUID-named host copies are never relaunched. If a host can't be inspected,
                // treat it as potentially owning this engine instead of guessing.
                let expected = image_key(&host);
                hosts
                    .iter()
                    .all(|path| {
                        path.as_ref()
                            .is_some_and(|path| image_key(path) != expected)
                    })
                    .then_some(None)
            }
            Owner::AdoptedEngine(lock) => {
                // An adopted copy doesn't name its host. Only act when no host in that data
                // directory owns the lock; keep it held through termination.
                let file = OpenOptions::new().read(true).write(true).open(lock).ok()?;
                file.try_lock().ok()?;
                Some(Some(file))
            }
        }
    }

    fn host_images(rows: &[(u32, u32, String)]) -> Vec<Option<PathBuf>> {
        rows.iter()
            .filter(|(_, _, name)| name.eq_ignore_ascii_case(HOST))
            .map(|(pid, _, _)| image_path(*pid))
            .collect()
    }

    pub(crate) fn scan(root: &Path) -> crate::Result<Vec<OrphanEngine>> {
        let root = root.canonicalize().map_err(crate::err)?;
        let candidates: Vec<_> = snapshot()?
            .into_iter()
            .filter(|(_, _, name)| name.eq_ignore_ascii_case(ENGINE_FILE_NAME))
            .filter_map(|(pid, _, _)| {
                let process = Process::open(pid).ok()??;
                let image = query_image(&process.handle)?;
                owner(&root, &image)?;
                Some((process, image))
            })
            .collect();
        let hosts = host_images(&snapshot()?);
        let mut result = Vec::new();
        for (process, image) in candidates {
            if !process.exited()? && unowned(&root, &image, &hosts).is_some() {
                result.push(OrphanEngine {
                    pid: process.pid,
                    identity: process.created.to_string(),
                    image: image.to_string_lossy().into_owned(),
                });
            }
        }
        result.sort_by_key(|p| p.pid);
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::Child;

        struct Fixture {
            root: PathBuf,
            children: Vec<Child>,
        }
        impl Fixture {
            fn spawn(&mut self, relative: &Path) -> u32 {
                let path = self.root.join(relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let source = std::env::var_os("SystemRoot").unwrap();
                std::fs::copy(PathBuf::from(source).join("System32/ping.exe"), &path).unwrap();
                let child = Command::new(path)
                    .args(["-t", "127.0.0.1"])
                    .creation_flags(0x08000000)
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                let pid = child.id();
                self.children.push(child);
                pid
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                for child in &mut self.children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        #[test]
        fn cleanup_stops_only_the_confirmed_instance() {
            let mut fixture = Fixture {
                root: std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
                children: Vec::new(),
            };
            let live = Path::new("hosts").join(uuid::Uuid::new_v4().to_string());
            fixture.spawn(&live.join(HOST));
            fixture.spawn(&live.join(ENGINE_FILE_NAME));
            fixture.spawn(Path::new(ENGINE_FILE_NAME)); // Same name, unrelated path.
            let orphan = Path::new("project-services-v1/development/hosts")
                .join(uuid::Uuid::new_v4().to_string())
                .join(ENGINE_FILE_NAME);
            let pid = fixture.spawn(&orphan);

            let mut rows = scan(&fixture.root).unwrap();
            assert_eq!(rows.iter().map(|row| row.pid).collect::<Vec<_>>(), [pid]);
            let mut target = rows.pop().unwrap();
            let identity = std::mem::take(&mut target.identity);
            assert!(stop(&fixture.root, &target).is_err());
            target.identity = identity;
            stop(&fixture.root, &target).unwrap();
            assert!(scan(&fixture.root).unwrap().is_empty());
            assert!(stop(&fixture.root, &target).is_err());
            for child in &mut fixture.children[..3] {
                assert!(child.try_wait().unwrap().is_none());
            }
        }
    }

    pub(crate) fn stop(root: &Path, target: &OrphanEngine) -> crate::Result<()> {
        let stale = || "This process is no longer a confirmed orphan. Scan again.".to_owned();
        let root = root.canonicalize().map_err(crate::err)?;
        let process = Process::open_with(target.pid, true)?.ok_or_else(stale)?;
        let image = query_image(&process.handle).ok_or_else(stale)?;
        if target.identity != process.created.to_string()
            || Path::new(&target.image) != image
            || process.exited()?
        {
            return Err(stale());
        }
        let _ownership = unowned(&root, &image, &host_images(&snapshot()?)).ok_or_else(stale)?;
        // SAFETY: use the same owned process object we just verified, not a reusable PID.
        if unsafe { TerminateProcess(process.handle.0, 1) } == 0 {
            return Err(crate::err(io::Error::last_os_error()));
        }
        // SAFETY: the process handle stays valid throughout this bounded wait.
        match unsafe { WaitForSingleObject(process.handle.0, 2000) } {
            0 => Ok(()),
            258 => Err("The engine has not exited yet. Scan again.".into()),
            _ => Err(crate::err(io::Error::last_os_error())),
        }
    }
}
#[cfg(feature = "desktop")]
pub(crate) use cleanup::{scan as scan_orphan_engines, stop as stop_orphan_engine};

/// Ends every process (and its descendants) whose executable is exactly `image`. Only an
/// executable private to one exited host qualifies: whatever runs from it is that host's
/// orphan, such as a project daemon its engine started.
pub(crate) fn stop_image(image: &std::path::Path) -> crate::Result<()> {
    let Some(file) = image.file_name().and_then(|n| n.to_str()) else {
        return Ok(());
    };
    let wanted = image_key(image);
    for (pid, _, name) in snapshot()? {
        if !name.eq_ignore_ascii_case(file) {
            continue;
        }
        if image_path(pid).is_some_and(|path| image_key(&path) == wanted) {
            stop_tree(pid)?;
        }
    }
    Ok(())
}
/// Whether a process with this executable file name runs, other than this one.
pub(crate) fn another_running(file_name: &str) -> crate::Result<bool> {
    let own = std::process::id();
    Ok(snapshot()?
        .into_iter()
        .any(|(pid, _, name)| pid != own && name.eq_ignore_ascii_case(file_name)))
}
fn owned_tree(pid: u32) -> crate::Result<Vec<Process>> {
    let Some(root) = Process::open(pid)? else {
        return Ok(Vec::new());
    };
    // Retained handles bind verification to process objects, even after their PIDs exit.
    let mut owned = HashMap::from([(pid, root)]);
    let raw = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if raw as isize == -1 {
        return Err(crate::err(io::Error::last_os_error()));
    }
    let snapshot = OwnedHandle(raw);
    let mut entry: ProcessEntry = unsafe { mem::zeroed() };
    entry.size = mem::size_of::<ProcessEntry>() as u32;
    let mut rows = Vec::new();
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while next != 0 {
        rows.push((entry.pid, entry.parent));
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if io::Error::last_os_error().raw_os_error() != Some(18) {
        return Err(crate::err(io::Error::last_os_error()));
    }
    loop {
        let before = owned.len();
        for &(child, parent) in &rows {
            if owned.contains_key(&child) {
                continue;
            }
            if let Some(parent) = owned.get(&parent) {
                if let Some(process) = Process::open(child)? {
                    if process.created >= parent.created {
                        owned.insert(child, process);
                    }
                }
            }
        }
        if before == owned.len() {
            break;
        }
    }
    Ok(owned.into_values().collect())
}

fn stop_descendants_after_root_exit(root: &Process, owned: &[Process]) -> crate::Result<()> {
    if !root.exited()? {
        return Ok(());
    }
    // A snapshot row can outlive its PID. Recheck ancestry while the first set of
    // process objects is held, then request termination only for matching identities.
    let confirmed: HashMap<_, _> = owned_tree(root.pid)?
        .into_iter()
        .map(|process| (process.pid, process.created))
        .collect();
    if confirmed.get(&root.pid) != Some(&root.created) {
        return Ok(());
    }
    for process in owned {
        if process.pid == root.pid
            || confirmed.get(&process.pid) != Some(&process.created)
            || process.exited()?
        {
            continue;
        }
        if let Ok(Some(target)) = Process::open_with(process.pid, true) {
            if target.created == process.created {
                // SAFETY: the termination handle names the same verified process object.
                // The caller confirms exit using the retained handles.
                unsafe { TerminateProcess(target.handle.0, 1) };
            }
        }
    }
    Ok(())
}

pub(crate) fn stop_tree(pid: u32) -> crate::Result<()> {
    stop_tree_with(pid, Duration::from_secs(2), |pid| {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()
            .map(|status| status.success())
            .map_err(crate::err)
    })
}

fn stop_tree_with(
    pid: u32,
    grace: Duration,
    request_stop: impl FnOnce(u32) -> crate::Result<bool>,
) -> crate::Result<()> {
    let owned = owned_tree(pid)?;
    let Some(root) = owned.iter().find(|process| process.pid == pid) else {
        return Ok(());
    };
    // The root can exit even when the stop command fails to launch.
    let launch_error = if root.exited()? {
        None
    } else {
        request_stop(pid).err()
    };
    // Only the retained process objects confirm exit.
    let deadline = Instant::now() + grace;
    let mut descendants_checked = false;
    loop {
        let mut running = Vec::new();
        for process in &owned {
            if !process.exited()? {
                running.push(process.pid);
            }
        }
        if running.is_empty() {
            return Ok(());
        }
        if !descendants_checked && !running.contains(&pid) {
            stop_descendants_after_root_exit(root, &owned)?;
            descendants_checked = true;
            continue;
        }
        if Instant::now() >= deadline {
            if let Some(error) = launch_error {
                return Err(error);
            }
            return Err(format!(
                "Could not stop engine process tree; still running: {running:?}"
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        process::{Child, Stdio},
    };
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = stop_tree(self.0.id());
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn child(command: &str) -> OwnedChild {
        OwnedChild(
            Command::new("cmd.exe")
                .args(["/D", "/C", command])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    fn fixture_parent(wait_for_release: bool) -> OwnedChild {
        OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "windows_process::tests::process_fixture",
                    "--nocapture",
                ])
                .env(
                    "WRONGSTACK_STOP_TREE_FIXTURE_PARENT",
                    if wait_for_release { "hold" } else { "exit" },
                )
                .creation_flags(0x08000000)
                .stdin(if wait_for_release {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    #[test]
    fn stop_success_requires_observed_process_exit() {
        let mut target = child("ping -n 30 127.0.0.1 > nul");
        let pid = target.0.id();
        let mut acknowledged = false;
        let stop = stop_tree_with(pid, Duration::ZERO, |requested| {
            assert_eq!(requested, pid);
            acknowledged = true;
            Ok(true)
        });
        let still_live = target.0.try_wait().unwrap().is_none();
        println!("EXPECTED: a command acknowledgement is insufficient while the root lives");
        println!("ACTUAL: stop {stop:?}, root still alive {still_live}");
        assert!(acknowledged);
        assert!(
            still_live,
            "the test never asked Windows to terminate this process"
        );
        assert!(stop.unwrap_err().contains("still running"));
    }

    #[test]
    fn successful_parent_stop_still_reaps_an_observed_child() {
        assert_parent_exit_reaps_child(Ok(true));
    }

    #[test]
    fn failed_stop_launch_still_reaps_an_observed_child() {
        assert_parent_exit_reaps_child(Err("Fixture stop command could not launch".into()));
    }

    #[test]
    fn failed_stop_launch_reports_the_error_when_the_root_still_lives() {
        let mut target = child("ping -n 30 127.0.0.1 > nul");
        let message = "Fixture stop command could not launch";
        let result = stop_tree_with(target.0.id(), Duration::ZERO, |_| Err(message.into()));

        assert_eq!(result.unwrap_err(), message);
        assert!(target.0.try_wait().unwrap().is_none());
    }

    fn assert_parent_exit_reaps_child(command_result: crate::Result<bool>) {
        let mut target = fixture_parent(true);
        let parent = target.0.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant = loop {
            if let Some(descendant) = owned_tree(parent).unwrap().into_iter().find(|process| {
                process.pid != parent
                    && image_path(process.pid).is_some_and(|image| {
                        image
                            .file_name()
                            .is_some_and(|name| name.eq_ignore_ascii_case("ping.exe"))
                    })
            }) {
                break descendant;
            }
            assert!(Instant::now() < deadline, "fixture child was not observed");
            thread::yield_now();
        };

        let mut survived_initial_stop = false;
        let result = stop_tree_with(parent, Duration::from_secs(2), |requested| {
            assert_eq!(requested, parent);
            target.0.stdin.take().unwrap().write_all(b"1").unwrap();
            target.0.wait().unwrap();
            survived_initial_stop = !descendant.exited().unwrap();
            command_result
        });
        let still_live = !descendant.exited().unwrap();
        if still_live {
            let _ = stop_tree(descendant.pid);
        }
        println!("EXPECTED: stop succeeds and the observed descendant exits");
        println!("ACTUAL: stop {result:?}, descendant still alive {still_live}");
        assert!(survived_initial_stop, "the reply must model a partial stop");
        assert!(result.is_ok(), "{result:?}");
        assert!(!still_live);
    }

    #[test]
    fn stopping_an_already_exited_owned_process_succeeds() {
        let mut target = child("exit 0");
        target.0.wait().unwrap();
        assert!(
            stop_tree(target.0.id()).is_ok(),
            "An already stopped owned process must not report stop failure"
        );
    }
    #[test]
    fn stops_a_live_owned_process_and_preserves_a_foreign_process() {
        let mut target = child("ping -n 30 127.0.0.1 > nul");
        let mut foreign = child("ping -n 30 127.0.0.1 > nul");
        assert!(target.0.try_wait().unwrap().is_none());
        assert!(foreign.0.try_wait().unwrap().is_none());
        stop_tree(target.0.id()).unwrap();
        assert!(target.0.wait().is_ok());
        assert!(
            foreign.0.try_wait().unwrap().is_none(),
            "Another owned fixture outside the target tree must survive"
        );
        stop_tree(foreign.0.id()).unwrap();
    }
    #[test]
    fn an_exited_parent_does_not_hide_a_live_descendant() {
        let mut target = fixture_parent(false);
        target.0.wait().unwrap();
        let tree = owned_tree(target.0.id()).unwrap();
        let descendants: Vec<_> = tree
            .iter()
            .filter(|process| process.pid != target.0.id() && !process.exited().unwrap())
            .collect();
        assert!(
            !descendants.is_empty(),
            "The fixture must have a real live descendant"
        );
        let result = stop_tree(target.0.id());
        let remaining: Vec<_> = descendants
            .iter()
            .filter(|process| !process.exited().unwrap())
            .map(|process| process.pid)
            .collect();
        // Always clean the fixture descendants, including when the contract assertion fails.
        for process in descendants {
            if !process.exited().unwrap() {
                let _ = stop_tree(process.pid);
            }
        }
        println!("EXPECTED: an owned descendant is stopped even after its parent exits");
        println!("ACTUAL: stop {result:?}, living descendants {remaining:?}");
        assert!(
            result.is_ok() && remaining.is_empty(),
            "The dead parent must not leave the owned descendant running"
        );
    }
    #[test]
    fn fallback_stop_rechecks_ancestry_before_terminating_a_live_process() {
        let mut parent = child("exit 0");
        let mut foreign = child("ping -n 30 127.0.0.1 > nul");
        parent.0.wait().unwrap();
        // A stale observation alone cannot authorize even a process with a matching live PID.
        let observed = [
            Process::open(parent.0.id()).unwrap().unwrap(),
            Process::open(foreign.0.id()).unwrap().unwrap(),
        ];
        stop_descendants_after_root_exit(&observed[0], &observed).unwrap();
        assert!(foreign.0.try_wait().unwrap().is_none());
    }
    #[test]
    fn process_fixture() {
        let Some(mode) = std::env::var_os("WRONGSTACK_STOP_TREE_FIXTURE_PARENT") else {
            return;
        };
        Command::new("ping.exe")
            .args(["-n", "120", "127.0.0.1"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if mode == "hold" {
            std::io::stdin().read_exact(&mut [0]).unwrap();
        }
        std::process::exit(0);
    }
}
