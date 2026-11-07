# `wstack desktop` — WrongStack Desktop

## What it does

Opens, installs and updates [WrongStack Desktop](../../apps/desktop-v2/README.md), the native
application. Like `wstack update`, it runs before any configuration is loaded, so it works without
a provider or profile.

```text
wstack desktop                       # open the app and return
wstack desktop install               # download, verify and install this CLI's release
wstack desktop install --version 1.5.0
wstack desktop install --silent      # Windows: no installer wizard
wstack desktop update                # install only when the installed copy is older
wstack desktop path                  # print the application and engine paths
```

## Opening

The application is looked up in this order:

1. `WRONGSTACK_DESKTOP_APP`: the executable, the directory holding it, or (macOS) the `.app`
   bundle. When it points at nothing, the command says so instead of opening another copy.
2. The installed copy:
   - Windows: the `InstallLocation` the installer recorded under
     `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\WrongStack Desktop`, then
     `%LOCALAPPDATA%\WrongStack Desktop\`.
   - macOS: `/Applications/WrongStack Desktop.app`, then `~/Applications/WrongStack Desktop.app`.
   - Linux: `/usr/bin/wrongstack-desktop-native` (the `.deb` and `.rpm` layout).
3. Inside a repository checkout, the portable build `apps/desktop-v2/dist-native/latest.json`
   names.

The application starts the engine (`wrongstack-engine`) that sits beside its own executable. A
copy without it cannot start, so `wstack desktop` refuses to open it and asks for a reinstall.
The application is started detached; the command returns at once.

## Installing and updating

`install` downloads this platform's installer from the GitHub release `v<version>` (the CLI's own
version unless `--version` names another), checks it against the release's `DESKTOP-SHA256SUMS`
and refuses a file that is not listed or does not match. Verified installers are kept under
`~/.wrongstack/downloads/desktop/`. Then:

- Windows: runs `wrongstack-desktop-<version>-windows-<arch>-setup.exe` (per-user, no
  administrator rights) and waits for it. `--silent` passes `/S`.
- macOS: opens the `.dmg`; drag WrongStack Desktop into Applications.
- Linux: never runs `sudo`. It prints the command to install the downloaded package:
  `sudo apt install <file>.deb` on dpkg systems, `sudo dnf install <file>.rpm` on rpm systems.

`update` installs only when the installed version (the Windows uninstall entry, the bundle's
`Info.plist`, or the dpkg/rpm package) is older than the release. When the version cannot be read,
it reinstalls and says so. A release without desktop installers is reported with a link to its
release page.

## Code reference

- `packages/cli/src/subcommands/handlers/desktop.ts`
- `packages/cli/src/desktop/`
