---
name: remote-debugging
description: "Remote debugging on servers over SSH: bounded journalctl and docker logs, ss, df, OOM kills, /proc, py-spy, thread dumps, tcpdump. Use when a deployed service misbehaves only on a known server or environment, local reproduction fails, or host signals (disk, memory, sockets, DNS, clock) need checking before any fix. Not for running the outage response (use incident-response) or SSH setup itself (use ssh-operations)."
trigger: "Use when a request asks why something fails on a specific server, staging or production host, and the evidence has to come from that host."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Remote Debugging

## Selection card
- Task: Find the cause of a failure on an authorized remote host from host evidence.
- Start: Pin the host, service, symptom and UTC window, then prove what is running (PID start time, release path or image digest) with read-only commands.
- Finish: a root cause backed by quoted host evidence is stated separately from any remediation, and every temporary capture, dump or port forward is removed.

## Overview

On a live host every command is an intervention: start read-only, bound every query in time and size, and prove which version is running before trusting its logs.
Verify the actual runtime/package/container versions and source identity on the target; current host facts outrank assumptions from local builds.
Escalate instrumentation one step at a time: logs and counters, then `/proc` and sockets, then sampling profilers, and tracing only with approval.

## Rules

1. Pin the authorized host, service or container, symptom and UTC window; access to one host never authorizes another.
2. Prove the running version: `ps -o pid,lstart,cmd -p <pid>`, `systemctl show <unit> -p ExecMainStartTimestamp`, `readlink -f /srv/app/current`, `docker inspect --format '{{.Image}}' <ctr>`. Logs from another release mislead.
3. Bound every read: `journalctl -u <unit> --since ... --until ... -n 500 --no-pager`, `docker logs --since 30m --tail 300`, `grep -m 50`. Never `cat` multi-GB logs or dump environments (`printenv`, `/proc/<pid>/environ`, `docker inspect` Env) into the transcript.
4. Check host signals with the app logs: disk and inodes, memory and OOM kills, CPU and iowait, file descriptors, socket states, DNS, clock and certificates.
5. Escalate instrumentation by cost: sampling profilers (py-spy, `jcmd <pid> Thread.print`) before tracing (strace, tcpdump, perf), and tracing only with approval, a time limit (`timeout 30`) and a count limit.
6. Debug ports bind to localhost and are reached through SSH forwards (`ssh -L 127.0.0.1:9229:127.0.0.1:9229 <host>`); a Node inspector on `0.0.0.0` is remote code execution.
7. Diagnosis is not remediation: no restarts, signals, config edits, package installs or in-place code edits without authorization; fixes go through the repository and deploy path.
8. Clean up dumps, captures and temp files (they hold secrets and PII), close forwards, and report anything left running.

## First moves by situation

| Situation | First moves |
|---|---|
| Fails only in production | Version identity; non-secret config keys compared with staging; `journalctl -u <unit> --since "-30min" -p err --no-pager`; dependency reachability from that host |
| Slow responses | `uptime`, `vmstat 1 5`, `iostat -xz 1 3`, `top -b -n1 -o %CPU \| head -20`, `ss -s`; upstream timing with `curl -w '%{time_connect} %{time_starttransfer}\n'` |
| Memory growth or OOM | `journalctl -k --since "-2h" \| grep -iE 'oom\|killed process'`; `ps -eo pid,rss,cmd --sort=-rss \| head`; `VmRSS` in `/proc/<pid>/status` |
| "Too many open files" or connection errors | `ls /proc/<pid>/fd \| wc -l` vs `grep 'open files' /proc/<pid>/limits`; `ss -tan state time-wait \| wc -l`; `ss -tnp state established '( dport = :5432 )'` |
| Disk full | `df -h`, `df -i`, `du -xh --max-depth=2 /var \| sort -h \| tail`; `lsof +L1` for deleted files still held open |
| DNS or outbound failures | `getent hosts api.example.com` (same resolver path as the app), `resolvectl status`, `curl -v --connect-timeout 5`; proxy variables |
| TLS errors to an upstream | `openssl s_client -connect api.example.com:443 -servername api.example.com -showcerts </dev/null`; CA bundle; `timedatectl` |
| Hung process | `py-spy dump --pid <pid>`; `jcmd <pid> Thread.print`; Go pprof endpoint on localhost; `cat /proc/<pid>/stack` as root |
| Container on the host | `docker stats --no-stream`, `docker logs --since 30m <ctr>`; host tools in its network namespace via `nsenter -t <pid> -n ss -tlnp` |
| Kubernetes workload | `kubectl logs --since=30m`, `kubectl debug`, `kubectl port-forward`; hand off to kubernetes-operations |

## Patterns and pitfalls

- **`dig` lies about the app's DNS** — it bypasses `/etc/hosts`, nsswitch and search domains; `getent hosts` follows the same path as `getaddrinfo`.
- **Deleted but open** — `df` shows full while `du` does not: a process holds a deleted log file. Freeing it needs a restart or truncation through `/proc/<pid>/fd`, both changes that need approval.
- **Time zones** — `journalctl` prints local time unless `--utc`; containers usually log UTC. Align windows before correlating.
- **Go and SIGQUIT** — Go processes dump goroutines and exit on SIGQUIT; use the pprof endpoint. Java prints a thread dump on `kill -3` and keeps running.
- **Node inspector on demand** — `kill -USR1 <pid>` opens the inspector on 127.0.0.1:9229; a breakpoint pauses live traffic, and health checks may restart the process.
- **ptrace cost** — strace can slow the target by orders of magnitude; prefer `strace -c -f -p <pid>` with `timeout`, or eBPF tools where installed. py-spy needs root or `CAP_SYS_PTRACE`.
- **Packet captures hold payloads** — tokens and PII; filter by host and port, cap with `-c`, write root-only files, delete after analysis.
- **Heap and core dumps** — contain secrets, can fill the disk, and `gcore` pauses the process while writing.
- **Missing tools in containers** — run host tools inside the container's namespaces with nsenter or a side-car instead of installing packages in production.
- **Raised log levels** — debug logging in production fills disks and can print secrets; time-box it and revert.
- **Hand edits drift** — editing files on the server is wiped by the next deploy and invisible to review; reproduce the fix in the repository.

## Workflow

1. Connect through the approved route; record host, user, time window and running version.
2. Read bounded service logs and host signals; write down the first anomaly in time, not the loudest.
3. Form one hypothesis and choose the cheapest check that could falsify it.
4. Escalate instrumentation only when needed and authorized; bound it in time and output.
5. Confirm the cause with evidence that appears with the symptom and is absent without it.
6. Hand the fix to the repository and deploy path; clean up and report remaining live risk.

## Proof

- Identity: running version tuple quoted from the host (PID start time, release path or digest)
- Evidence: the exact log lines, counters or dump excerpts that show the cause, with timestamps, secrets redacted
- Host baseline: `df -h`, `df -i`, `free -m`, `uptime`, and the relevant `ss` summary at the time of diagnosis
- After an authorized fix: the same bounded query shows the symptom gone (`journalctl -u <unit> --since "-15min" -p err --no-pager` empty for that error)
- Cleanup: capture and dump paths removed; local forwards gone from `ss -tlnp`; `ssh -O exit <host>` for multiplexed sessions

## Stop and ask

- Restarting, killing or signalling processes, or attaching strace, tcpdump, perf or a debugger in production.
- Installing packages or tools on the host, or running as root when not required.
- Reading secrets, environment dumps, heap or core dumps, or packet payloads.
- Reaching hosts beyond the authorized one, or editing live config or code.

## Before returning

- [ ] Authorized host, service, running version and UTC window recorded
- [ ] All reads bounded by time and size; no secrets or environment dumps in output
- [ ] Host signals (disk, inodes, memory/OOM, fds, sockets, DNS, clock, TLS) checked alongside app logs
- [ ] Root cause supported by quoted host evidence; ruled-out hypotheses listed
- [ ] Remediation separated from diagnosis and done only if authorized
- [ ] Temporary dumps, captures, files and port forwards removed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[systemd journal](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html), [OpenTelemetry](https://opentelemetry.io/docs/).

## Skills in scope

- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- debugging — reproduce and fix the localized defect in the repository with a regression test.
- incident-response — diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health.
- container-debugging — container state, images and namespaces on the host.
- observability — metrics and traces that narrow the window before touching the host.
