---
name: ssh-operations
description: "OpenSSH client and server work: ~/.ssh/config, keys, known_hosts, ProxyJump bastions, agent, tunnels, scp/rsync, sshd_config. Use when connecting to or copying files with an authorized host, fixing Permission denied or host-key errors, setting up bastions and port forwards, or changing sshd_config without locking anyone out. Not for service management after login (use linux-service-ops) or diagnosing the app (use remote-debugging)."
trigger: "Use when a request involves ssh, scp, sftp or rsync to a host, ~/.ssh/config, keys, host-key warnings, tunnels or sshd_config."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Ssh Operations

## Selection card
- Task: Establish verified SSH access, transfers and tunnels to explicitly authorized hosts, and change sshd safely.
- Start: Print the effective client config for the target (`ssh -G <alias>`) and confirm host, port, user, jump host and key match the authorization.
- Finish: a non-interactive connection to the verified host key succeeds, the requested transfer or change is verified on the remote side, and tunnels, control sockets and staging files are closed or documented.

## Overview

SSH safety rests on two facts you must verify rather than assume: the host key proves which machine you reached, and the effective config (`ssh -G`, `sshd -T`) shows which settings actually apply.
Checked upstream target 2026-11-02: OpenSSH portable 10.6p1. Distribution and Windows builds may carry different versions/backports; inspect installed support before changing host/client software.
OpenSSH 10 removed DSA keys and defaults to a post-quantum hybrid key exchange; very old servers and appliances may need per-host compatibility settings.

## Rules

1. Connect only to the authorized host, port, user and jump host; a session on one host never authorizes pivoting to its neighbours.
2. Verify host keys against an out-of-band fingerprint (console `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, or the provider's published value). A changed-key warning is a stop condition; never set `StrictHostKeyChecking=no` or `UserKnownHostsFile=/dev/null`. `ssh-keyscan` is trust-on-first-use, not verification.
3. Prefer ed25519 or hardware-backed `-sk` keys with a passphrase or agent; `~/.ssh` at 700 and keys at 600; `IdentitiesOnly yes` per host; never print private keys. Restrict automation keys in `authorized_keys` with `restrict`, `from=` and `command=`.
4. Keep `ForwardAgent no`; reach inner hosts with `ProxyJump` (`ssh -J`) so the jump host never holds your keys or agent.
5. In automation pass `-o BatchMode=yes -o ConnectTimeout=10`, keep remote commands idempotent, and send scripts with `ssh <host> 'bash -s' < script.sh` (script starting `set -euo pipefail`) instead of nested quoting.
6. For sshd changes: back up, `sshd -t`, confirm `sshd -T`, reload rather than restart, and keep the current session open until a fresh login succeeds in a second terminal.
7. Preview transfers: `rsync --dry-run --itemize-changes` first; `--delete` only with approval; stage, checksum, then move atomically into place.
8. Bind local forwards to 127.0.0.1, set `ExitOnForwardFailure yes`, and close forwards and multiplexed sessions (`ssh -O exit <alias>`) when done.

## First moves by situation

| Situation | First moves |
|---|---|
| `Permission denied (publickey)` | `ssh -v <alias>` shows keys offered and the server's answer; `ssh -G <alias>` for user, port, identityfile; server side: auth log or `journalctl -u ssh -n 50`, `authorized_keys` mode and a home directory that is not group-writable |
| "Too many authentication failures" | The agent offers every key; set `IdentitiesOnly yes` with an explicit `IdentityFile` |
| "REMOTE HOST IDENTIFICATION HAS CHANGED" | Stop. Verify out of band (reinstall, IP reuse, or interception); only after confirmation `ssh-keygen -R <host>` and accept the verified key |
| Timeout or refused | DNS, security group or firewall, `nc -vz <host> 22`; sshd listening (console `ss -tlnp`); fail2ban or OpenSSH `PerSourcePenalties` refusing after failed attempts |
| Hangs after login | Shell startup files blocking or printing; test `ssh -T <alias> true`; MTU on VPN paths |
| Reach an internal host | `Host internal` with `ProxyJump bastion` in config, or `ssh -J bastion internal` |
| Tunnel to a remote database | `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:15432:127.0.0.1:5432 <alias>` |
| Harden sshd | Drop-in under `/etc/ssh/sshd_config.d/`; `sshd -t`; `sshd -T \| grep -iE '^(port\|passwordauthentication\|permitrootlogin) '`; reload; test a new session |
| Large copy or sync | `rsync -aH --info=progress2 --dry-run --itemize-changes src/ <alias>:/dst/`, review, then run without `--dry-run` |
| Windows OpenSSH server | Members of Administrators authenticate from `C:\ProgramData\ssh\administrators_authorized_keys` with restricted ACLs, not the user's own file |

## Patterns and pitfalls

- **First value wins in sshd** — for most keywords sshd keeps the first value it reads; distributions `Include sshd_config.d/*.conf` near the top, so a cloud-init drop-in such as `50-cloud-init.conf` can keep `PasswordAuthentication yes` despite your edit lower down. Trust `sshd -T`, not the file.
- **Socket-activated sshd** — on recent Ubuntu, `ssh.socket` owns the listening port; changing `Port` needs `systemctl daemon-reload` and a restart of `ssh.socket` (check the release notes), or the new port never opens.
- **Lockout order** — open the firewall for a new port before moving sshd; disable passwords only after key login is proven in a second session.
- **`scp` uses SFTP** — since OpenSSH 9.0 `scp` speaks SFTP, so remote wildcard and quoting behaviour changed; `-O` forces the legacy protocol for old servers.
- **Legacy algorithms** — SHA-1 `ssh-rsa` signatures are disabled by default; re-enable per host (`HostKeyAlgorithms +ssh-rsa`) only for a documented legacy appliance, never globally.
- **rsync trailing slash** — `src/` copies the contents, `src` copies the directory itself; with `--delete` that difference can empty a target.
- **Agent hijack** — root on a host you forward your agent to can use your keys while you are connected; `ProxyJump` avoids it.
- **Multiplexing surprises** — `ControlMaster`/`ControlPersist` reuse an old session, so new config or keys seem ignored; `ssh -O check <alias>` and `ssh -O exit <alias>`.
- **Remote quoting** — the remote shell re-parses the command line; variables expand locally unless quoted. Prefer `bash -s` with a script on stdin.
- **Keepalives** — NAT and firewalls drop idle sessions; set `ServerAliveInterval 30` and `ServerAliveCountMax 3` in the host entry.

## Workflow

1. Confirm the authorization scope; read `ssh -V`, `ssh -G <alias>` and the relevant host entry (redact secrets).
2. Verify the host key fingerprint against an out-of-band source.
3. Connect through the approved route with batch options; record OS, user and working directory.
4. Perform the bounded task: transfer with dry-run first, or config change with backup and validation.
5. Verify the result on the remote side (checksums, `sshd -T`, a fresh login).
6. Close tunnels and control sockets, remove staging files, and report anything left running.

## Proof

- Effective client config: `ssh -G <alias> | grep -iE '^(hostname|user|port|identityfile|proxyjump|forwardagent) '`
- Non-interactive reachability: `ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> true` exits 0
- Host key: the fingerprint shown on first connect (or `ssh-keygen -lF <host>`) equals the out-of-band value
- sshd change: `sshd -t` clean, `sshd -T` shows intended values, and a second-terminal login succeeds before closing the first
- Transfer: reviewed `--itemize-changes` output; `sha256sum` matches on both sides
- Cleanup: `ssh -O exit <alias>`; no leftover listeners in `ss -tlnp` for forwarded ports

## Stop and ask

- A host-key mismatch, or no way to verify the fingerprint.
- Any change to sshd_config, PAM, firewall rules, users or `authorized_keys` on a server.
- `rsync --delete`, overwriting remote files, or recursive `chown`/`chmod` on the remote side.
- Agent forwarding, root login, or any host outside the stated scope.
- Keys or passphrases would need to be created, copied or entered on the user's behalf.

## Before returning

- [ ] Target host, port, user and jump host matched to the authorized scope
- [ ] Host key verified out of band; strict checking left on
- [ ] Keys restricted (`IdentitiesOnly`, file modes), agent forwarding off, no private material in output
- [ ] Transfers previewed with dry-run and verified by checksum
- [ ] sshd changes validated with `sshd -t`/`sshd -T` and a fresh login before the old session closed
- [ ] Tunnels, control sockets and staging files closed or documented

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[OpenSSH releases](https://www.openssh.com/releasenotes.html), [SSH config](https://man.openbsd.org/ssh_config).

## Skills in scope

- linux-service-ops — owned service configuration and lifecycle.
- remote-debugging — bounded evidence on the authorized host.
- vps-deploy — versioned deployment to the authorized server.
- reverse-proxy-tls — firewall and port changes that sit next to the proxy on the same host.
