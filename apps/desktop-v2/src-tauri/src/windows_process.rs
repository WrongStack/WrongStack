//! Windows session termination; taskkill's status includes races with exiting descendants.
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::{
    collections::HashMap,
    ffi::c_void,
    io, mem, thread,
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
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
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
        let raw = unsafe { OpenProcess(0x00101000, 0, pid) };
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

pub(crate) fn stop_tree(pid: u32) -> crate::Result<()> {
    let owned = owned_tree(pid)?;
    if owned.is_empty() {
        return Ok(());
    }
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .status()
        .map_err(crate::err)?;
    if !status.success() {
        // Exiting git/conhost descendants can make taskkill fail after it stopped the tree.
        // Accept that race only after every observed owned process object has exited.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut running = Vec::new();
            for process in &owned {
                if !process.exited()? {
                    running.push(process.pid);
                }
            }
            if running.is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Could not stop engine process tree; still running: {running:?}"
                ));
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Stdio};
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
        let mut target = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "windows_process::tests::process_fixture",
                    "--nocapture",
                ])
                .env("WRONGSTACK_STOP_TREE_FIXTURE_PARENT", "1")
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
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
        // Always clean the fixture descendants, including when the contract assertion fails.
        for process in descendants {
            let _ = stop_tree(process.pid);
        }
        assert!(
            result.is_err(),
            "A dead root must not turn a surviving descendant into stop success"
        );
    }
    #[test]
    fn process_fixture() {
        if std::env::var_os("WRONGSTACK_STOP_TREE_FIXTURE_PARENT").is_none() {
            return;
        }
        Command::new("ping.exe")
            .args(["-n", "120", "127.0.0.1"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::process::exit(0);
    }
}
