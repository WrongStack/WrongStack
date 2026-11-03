---
name: vps-deploy
description: "VPS deployment over SSH: release directories, symlink switch, systemd or Compose services, env files, firewall, health, rollback. Use when shipping an app to an owned Linux server or bare-metal host, fixing a broken server deploy, writing a deploy script, or adding zero-downtime cutover and rollback. Not for Kubernetes clusters (use kubernetes-operations) or Cloudflare Workers (use cloudflare-workers)."
trigger: "Use when a request is about deploying to or repairing an app on a specific VPS or server: deploy scripts, release folders, services, ports or firewall."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
---

# Vps Deploy

## Selection card
- Task: Release an application to an existing, explicitly authorized server.
- Start: Inventory the host read-only: OS and arch, disk and memory, running services and listeners (`ss -ltnp`), proxy virtual hosts, the current release and how it starts.
- Finish: the new release runs from its own directory or digest under its service user, loopback and public health checks pass, logs are clean, and the previous release plus the rollback command are recorded.

## Overview

A VPS deploy is safe when the release is built elsewhere, staged beside the running one, health-checked on loopback, switched atomically, and the previous release stays one command away.
Resolve current stable application/runtime targets through tech-stack, then verify host OS/architecture and supported packages. Do not replace an entire host toolchain merely because upstream released a newer version.
Small servers are shared and fragile: other sites, cron jobs and databases often live on the same host.

## Rules

1. Pin host, deploy user, app directory, systemd unit or Compose project, loopback port and domain; inventory co-located services before choosing ports or reloading anything shared.
2. Build off-host (CI or a matching OS and arch) and ship an artifact with a checksum, or an image digest; never `git pull` and build inside the serving directory.
3. Lay out `releases/<utc>-<sha>/`, `shared/` (0600 env file, uploads, SQLite) and a `current` symlink; switch with a temporary link plus `mv -T` (an atomic rename), because `ln -sfn` alone unlinks then recreates.
4. Switching the symlink does not change running code: restart or reload the service afterwards, and point units, cron and timers at `current` paths rather than a specific release.
5. Health-check the new release on loopback before it takes traffic; for zero downtime run it on a second port and switch the proxy upstream, or use socket activation.
6. Expose only 22, 80 and 443; bind the app and database to 127.0.0.1. Docker-published ports bypass ufw, and the provider's cloud firewall is a separate layer to check.
7. Preflight `df -h`, `df -i` and `free -m`; keep migrations backward compatible with the running release and back up before risky ones.
8. Keep several previous releases and prune only outside the rollback window.

## First moves by situation

| Situation | First moves |
|---|---|
| First deploy to a new server | Read-only inventory; then (approved) service user, directories, unit, proxy site, firewall; deploy |
| Review a deploy script | `set -euo pipefail`, idempotency, checksum check, health gate before switch, atomic switch, automatic rollback on failed health |
| Site down after deploy | `systemctl status <unit>`, `journalctl -u <unit> -n 100 --no-pager`, `readlink -f /srv/app/current`, loopback curl, proxy error log; roll back by repointing `current` and restarting |
| Port already in use | `ss -ltnp 'sport = :3000'` names the owner; pick a free port instead of stopping someone else's process |
| Loopback works, public fails | DNS, proxy `server_name`, host and cloud firewall, TLS; hand off to reverse-proxy-tls |
| Disk full | Old releases, Docker images (`docker system df`), unrotated logs; prune only with approval and outside the rollback set |
| Env or secret change | `shared/.env` mode 0600 owned by the service user, loaded with `EnvironmentFile=`; restart required; never echo values |
| Docker-based host | Compose file with pinned digests; `docker compose pull` then `docker compose up -d --wait`; hand off to compose-operations |
| Roll back | `ln -s releases/<previous> current.tmp && mv -T current.tmp current` inside the app directory, restart the unit, check the version endpoint |

## Patterns and pitfalls

- **Old code keeps running** — processes resolved their working directory and loaded modules at start; a switched symlink without a restart serves the old release.
- **PHP-FPM caches paths** — with symlink deploys use `$realpath_root` in the FastCGI parameters and reload PHP-FPM so opcache stops serving the previous release.
- **State inside a release** — uploads or SQLite files written under `releases/<id>` disappear on the next deploy; link them from `shared/`.
- **Native modules built elsewhere** — packages like sharp or bcrypt built on macOS fail on Linux; build on the target platform, or install with the frozen lockfile into the new release directory, never into `current`.
- **Builds on a small VPS** — compiling on a 1-2 GB host OOM-kills the running app; another reason to build off-host.
- **Writable code** — release files owned by the deploy user and read-only to the service user; only `shared/` paths are writable.
- **Reboots** — unattended upgrades may reboot; services must be `enable`d and come back with `Restart=on-failure`.
- **Migrations per instance** — run migrations once with a lock, not on every process start.
- **Cron pinned to a release** — jobs referencing `releases/<old>` keep running old code after the switch.
- **Two firewalls** — host ufw or nftables and the provider's cloud firewall both apply; a port open in one and closed in the other looks like an app bug.

## Workflow

1. Inventory the host read-only and record the current release, unit, port and health.
2. Build and test the artifact off-host; produce a checksum or digest.
3. Upload to a new release directory, verify the checksum, link `shared/` paths, install nothing into `current`.
4. Run migrations if needed (backward compatible, backed up), then start the new release on loopback and health-check it.
5. With authorization, switch atomically and restart or move the proxy upstream; watch logs and the public route.
6. Record the deployed SHA, previous release and rollback command; prune old releases only outside the rollback window.

## Proof

- Preflight: `ssh <alias> 'df -h / && df -i / && free -m && ss -ltnp'`
- Artifact: `sha256sum -c app.tar.gz.sha256` on the host
- Pre-switch health: `curl -fsS http://127.0.0.1:<new-port>/healthz`
- Switch: `readlink -f /srv/app/current`; `systemctl is-active <unit>`; `systemctl show <unit> -p ExecMainStartTimestamp` later than the switch
- Public: `curl -fsS https://app.example.com/version` reports the new SHA
- Logs: `journalctl -u <unit> --since "-10min" -p warning --no-pager` clean
- Exposure: `ss -ltnp` shows the app on 127.0.0.1 only; `ufw status verbose`

## Stop and ask

- Any change on a production server: deploy, restart, proxy reload or firewall edit.
- Creating users, installing packages, adding swap, OS upgrades or reboots.
- Running migrations, or deleting releases, images or data.
- Firewall or port changes that could cut SSH access, or anything touching co-located services.

## Before returning

- [ ] Host, deploy user, unit or Compose project, port, domain and prior release recorded
- [ ] Artifact built off-host, checksum or digest verified on the server
- [ ] Release staged in its own directory; `shared/` state and secrets preserved with correct owners and modes
- [ ] Loopback health passed before the switch; switch atomic; service restarted onto the new release
- [ ] Public HTTPS route, version endpoint and post-switch logs verified
- [ ] App and database bound to loopback; only intended ports open in both firewalls
- [ ] Previous release retained and the exact rollback command documented

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [Docker production](https://docs.docker.com/compose/how-tos/production/).

## Skills in scope

- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- reverse-proxy-tls — configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
- compose-operations — Docker Compose stacks on the same host.
