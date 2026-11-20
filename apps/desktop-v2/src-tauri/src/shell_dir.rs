//! The directory a terminal's shell starts in.
use std::path::PathBuf;

/// `workdir` as a shell should see it. The registry keeps canonical paths, which on Windows are
/// verbatim (`\\?\D:\repo`); a pseudo console passes that to the shell unchanged, and PowerShell
/// then opens in `Microsoft.PowerShell.Core\FileSystem::\\?\D:\repo`. A path too long to be
/// written without the prefix keeps it.
pub(crate) fn shell_dir(workdir: &str) -> PathBuf {
    if cfg!(windows) {
        let plain = if let Some(unc) = workdir.strip_prefix(r"\\?\UNC\") {
            Some(format!(r"\\{unc}"))
        } else {
            workdir
                .strip_prefix(r"\\?\")
                .filter(|rest| rest.as_bytes().get(1) == Some(&b':'))
                .map(str::to_owned)
        };
        if let Some(plain) = plain.filter(|p| p.len() < 248) {
            return PathBuf::from(plain);
        }
    }
    PathBuf::from(workdir)
}

#[cfg(test)]
mod tests {
    use super::shell_dir;
    #[cfg(windows)]
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn only_the_verbatim_prefix_is_dropped_and_only_where_the_path_still_fits() {
        assert_eq!(
            shell_dir(r"\\?\D:\Codebox\repo"),
            PathBuf::from(r"D:\Codebox\repo")
        );
        assert_eq!(
            shell_dir(r"\\?\UNC\server\share\repo"),
            PathBuf::from(r"\\server\share\repo")
        );
        assert_eq!(
            shell_dir(r"D:\Codebox\repo"),
            PathBuf::from(r"D:\Codebox\repo")
        );
        // Not a drive path: a device or volume name stays as it is.
        let volume = r"\\?\Volume{0b1c2d3e-0000-0000-0000-100000000000}\repo";
        assert_eq!(shell_dir(volume), PathBuf::from(volume));
        let long = format!(r"\\?\D:\{}", "a".repeat(300));
        assert_eq!(shell_dir(&long), PathBuf::from(&long));
    }

    #[cfg(windows)]
    #[test]
    fn a_terminal_shell_starts_in_the_project_path_not_its_verbatim_form() {
        use crate::registry::Registry;
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};

        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let project_dir = dir.join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();
        let db = Registry::open(&dir.join("state")).unwrap();
        let project = db.register(project_dir.to_str().unwrap()).unwrap();
        // The workdir a terminal session is recorded with, from the registry's canonical root.
        let workdir = db
            .workdir(&project.id, None)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        drop(db);

        // Started the way `open_terminal` starts it: a pseudo console, not `std::process`
        // (which hands the shell a plain directory on its own).
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 250,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let shell = PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(shell_dir(&workdir));
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Write-Output \"<<$PWD>>\"",
        ]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&output);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // The pseudo console waits for its cursor query to be answered, as the
                // desktop's transcript reader does.
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        child.wait().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        drop(pair.master);
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        std::fs::remove_dir_all(&dir).unwrap();

        let location = text
            .split("<<")
            .nth(1)
            .and_then(|rest| rest.split(">>").next())
            .unwrap_or_default()
            .to_owned();
        let plain = workdir.strip_prefix(r"\\?\").unwrap_or(&workdir);
        assert!(
            location.eq_ignore_ascii_case(plain),
            "the shell's location is {location:?}, expected {plain:?}"
        );
    }
}
