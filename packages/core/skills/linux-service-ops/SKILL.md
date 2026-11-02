---
name: linux-service-ops
description: "systemd services on Linux: unit files, drop-ins, systemctl, journalctl, timers, sockets, service users, sandboxing and cgroup limits. Use when writing or fixing a .service, .timer or .socket unit, a service fails to start or restarts in a loop, logs need reading, or a daemon needs a dedicated user, secrets, resource limits or hardening. Not for container runtimes (use container-debugging) or proxy and TLS config (use reverse-proxy-tls)."
trigger: "Use when a request touches systemd units, systemctl or journalctl output, a failed or restarting service, timers replacing cron, or service users and permissions."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
paths: ["*.{service,timer,socket}"]
---

# Linux Service Ops

## Selection card
- Task: Configure, harden or repair systemd-managed services on an authorized Linux host.
- Start: Read `systemctl status <unit>`, `systemctl cat <unit>` and a bounded `journalctl -u <unit>` window; note the owning user, listening sockets and access paths (SSH) you must not disturb.
- Finish: `systemd-analyze verify` is clean, the unit is active with the expected PID, user and socket, a clean stop/start works, and the boot enablement state is what was asked.

## Overview

systemd runs a service in a minimal, non-login environment under its own user, namespaces and cgroup; most "works in my shell, fails as a service" bugs are that difference, and the merged unit (`systemctl cat`) plus the exit status already name it.
Checked upstream systemd release: 262.1 (2026-10-23). Use the distro-supported systemd package and its actual unit directives; upstream latest does not justify replacing the host OS service manager.
systemd 258 removed cgroup v1, and SysV init-script support is deprecated or removed in later releases; check the NEWS for the host's version.

## Rules

1. Read before editing: `systemctl status <unit> --no-pager -l`, `systemctl cat <unit>`, `systemctl show <unit> -p Result,ExecMainStatus,NRestarts,User,MainPID`, and `journalctl -u <unit> -b --since "-30min" --no-pager`.
2. Customize vendor units through drop-ins (`systemctl edit <unit>` writes `/etc/systemd/system/<unit>.d/override.conf`); never edit files under `/usr/lib/systemd` or `/lib/systemd`. `systemctl edit --full` forks the whole unit and stops tracking vendor fixes.
3. Use the right verb: `daemon-reload` re-reads unit files (needed after edits, restarts nothing); `reload` runs ExecReload; `restart` stops and starts; `enable --now` adds boot persistence and starts; `mask` blocks every start.
4. ExecStart is not a shell: absolute paths, limited `${VAR}` expansion, no pipes or redirects unless you wrap `/bin/sh -c`. In a drop-in, an empty `ExecStart=` line must precede the replacement.
5. Deliver secrets with `LoadCredential=` or `LoadCredentialEncrypted=` (files under `$CREDENTIALS_DIRECTORY`, made with `systemd-creds encrypt`) or a root-owned 0600 `EnvironmentFile=`; `Environment=` values show in `systemctl show`, and argv shows in `ps`.
6. Sandbox to measured needs: dedicated user or `DynamicUser=yes`, `StateDirectory=`/`RuntimeDirectory=`/`LogsDirectory=` (created and chowned for you), `ProtectSystem=strict` with `ReadWritePaths=`, `NoNewPrivileges=yes`, `PrivateTmp=yes`; score with `systemd-analyze security <unit>`.
7. Restart with limits: `Restart=on-failure`, `RestartSec=`, and `StartLimitIntervalSec=`/`StartLimitBurst=` in `[Unit]`; once the limit trips the unit stays failed until `systemctl reset-failed <unit>`.
8. Protect access paths: never stop, restart or mask sshd, networking, firewall or container-runtime units, or reboot, without approval and a second open session.

## First moves by situation

| Situation | First moves |
|---|---|
| Fails to start | `journalctl -xeu <unit>`; decode status: 200/CHDIR missing WorkingDirectory, 203/EXEC bad path, mode or shebang, 217/USER unknown user, 226/NAMESPACE missing sandbox path, 243/CREDENTIALS unreadable credential |
| "Start request repeated too quickly" | `systemctl show -p NRestarts <unit>`; read the first failure, fix it, then `systemctl reset-failed <unit>` |
| Works in a shell, not as a service | Reproduce the service context: `systemd-run --pty --wait -p User=app -p WorkingDirectory=/srv/app /srv/app/bin/server --check`; compare PATH, HOME, `PrivateTmp`, `ProtectHome`, SELinux |
| Starts before its dependencies | `Wants=` plus `After=network-online.target` or the database unit; ordering is not readiness, so the app must retry |
| Timed out on start | `Type=notify` without `READY=1`, `forking` without a matching PIDFile, or a slow boot; match `Type=` to the program and set `TimeoutStartSec=` |
| Scheduled job | Timer with `OnCalendar=`, `Persistent=true`, `RandomizedDelaySec=`; `systemd-analyze calendar "Mon *-*-* 03:00"`; `systemctl list-timers` |
| Port below 1024 as non-root | `AmbientCapabilities=CAP_NET_BIND_SERVICE` with a matching `CapabilityBoundingSet=`, or socket activation |
| Too many open files | `LimitNOFILE=` in the unit (shell `ulimit` does not apply); confirm in `/proc/<pid>/limits` |
| Memory or CPU runaway | `systemd-cgtop`; `MemoryHigh=`, `MemoryMax=`, `CPUQuota=`, `TasksMax=`; `systemctl set-property --runtime <unit> MemoryMax=1G` for a temporary cap |
| User service dies at logout | `loginctl enable-linger <user>`; manage it with `systemctl --user` |

## Patterns and pitfalls

- **Minimal environment** — services do not read `/etc/profile` or `.bashrc`; nvm, pyenv and asdf shims are missing, so use absolute interpreter paths.
- **`Type=` mismatch** — `Type=simple` reports success before exec; `Type=exec` waits for a successful exec; `Type=notify` without the notification is killed at timeout; `Type=forking` with a wrong PIDFile looks dead.
- **Override discovery** — `systemd-delta --type=extended,overridden` lists every drop-in and masked unit; precedence is `/etc` over `/run` over `/usr/lib`, drop-ins applied in lexical order.
- **`PrivateTmp=yes`** — the service sees its own `/tmp`; sockets or files other processes expect in `/tmp` vanish.
- **`ProtectHome=yes`** — applications installed under `/home` fail with permission or namespace errors.
- **Stop semantics** — `KillMode=control-group` (default) signals every child; after `TimeoutStopSec=` systemd sends SIGKILL, so the drain must finish inside it.
- **Forgotten reload** — "unit file changed on disk" means the running definition is stale; run `systemctl daemon-reload` before restart.
- **Journal loss** — rate limiting drops lines ("Suppressed N messages") and `SystemMaxUse=` rotation deletes history; check `journalctl --disk-usage` before relying on old logs.
- **MAC denials** — SELinux shows in `ausearch -m avc -ts recent`, AppArmor in `journalctl -k | grep -i apparmor`; fix labels or profiles instead of disabling enforcement.
- **Socket activation** — a `.socket` unit keeps the port open while the service restarts, giving zero-dropped-connection restarts for compatible apps.

## Workflow

1. Identify host, unit, owner, user, listening sockets and anything sharing the host (`systemctl list-units --type=service --state=running`).
2. Read the merged unit, status, exit code and a bounded journal window; classify the failure.
3. Write the change as a drop-in or a project-owned unit; keep secrets in credentials or a 0600 file.
4. `systemd-analyze verify`, then `daemon-reload`, then the authorized transition (reload over restart where supported).
5. Confirm PID, user, socket, health and a clean stop; check enablement for boot.
6. Report changed files, commands, downtime and how to revert (remove the drop-in, reload, restart).

## Proof

- Syntax: `systemd-analyze verify /etc/systemd/system/<unit>.service`
- State: `systemctl is-active <unit>`, `systemctl is-enabled <unit>`, `systemctl show <unit> -p MainPID,NRestarts,ExecMainStartTimestamp`
- Logs: `journalctl -u <unit> -b --since "-5min" -p warning --no-pager`
- Socket and user: `ss -ltnp 'sport = :8080'`, `ps -o user,pid,cmd -p <pid>`
- Health: `curl -fsS http://127.0.0.1:8080/healthz`
- Hardening: `systemd-analyze security <unit>` exposure score before and after
- Clean stop: `systemctl stop <unit>` returns within `TimeoutStopSec=` and the journal shows no SIGKILL

## Stop and ask

- Restarting, stopping or masking units on a production host, or any unit that carries access (sshd, networking, firewall, container runtime).
- Reboots, kernel or systemd package upgrades, or journald changes that delete retained logs.
- Creating or removing system users, or changing ownership of existing data directories.
- Editing vendor unit files under `/usr/lib` or `/lib`.

## Before returning

- [ ] Host, unit, owner and the access paths left untouched recorded
- [ ] Changes live in drop-ins or owned units under `/etc/systemd/system`; `daemon-reload` run
- [ ] `systemd-analyze verify` clean; ExecStart uses absolute paths
- [ ] Secrets delivered via credentials or a 0600 file, absent from `systemctl show` and argv
- [ ] Sandboxing matches real writable paths; security score reported
- [ ] Active PID, user, socket, health check and clean stop observed; `is-enabled` state as requested

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[systemd service contract](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd releases](https://github.com/systemd/systemd/releases).

## Skills in scope

- ssh-operations — verified authorized remote connection.
- remote-debugging — bounded evidence on the authorized host.
- observability — runtime signals and correlation.
- release-rollback — version promotion and recovery compatibility.
- vps-deploy — release directories and service units for a deployed app.
