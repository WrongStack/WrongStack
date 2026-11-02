---
name: compose-operations
description: "Docker Compose stacks: compose.yaml, overrides, profiles, depends_on healthchecks, networks, named volumes, .env and published ports. Use when wiring or updating multi-service stacks, fixing unhealthy dependencies, exposed ports, lost volumes or env interpolation, or running Compose on a single production host. Not for Dockerfile and image builds (use docker-deploy) or one crashing container (use container-debugging)."
trigger: "Use when a request touches compose.yaml or docker-compose*.yml, docker compose up/down, service healthchecks, Compose volumes, networks or .env files."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
paths: ["docker-compose*.{yml,yaml}", "compose.{yml,yaml}", "compose.*.{yml,yaml}"]
---

# Compose Operations

## Selection card
- Task: Operate and evolve multi-service Docker Compose stacks.
- Start: Run `docker compose config` with the exact `-f`, `--profile` and project name the operator uses, and `docker compose ps -a` for current state.
- Finish: `docker compose up -d --wait` reports every service healthy, the app answers through its real port, and named volumes still hold their data.

## Overview

Compose state is keyed by project name: containers, networks and volumes are named `<project>_<name>`, so the merged config and the project identity decide what a command touches.
Checked targets 2026-11-02: Docker Engine 29.9.2 and Compose 5.7.0. Verify installed plugin/engine support and release notes; do not introduce a legacy top-level compose version key.
Use the `docker compose` plugin; the Python `docker-compose` v1 is end-of-life and parses some files differently.

## Rules

1. Review the effective merged configuration (`docker compose config`) with the same files, profiles, `.env` and project name as the real operator before any lifecycle command.
2. Never run `docker compose down -v`, `docker volume rm`, `docker system prune --volumes` or rename a volume or project on a data-bearing stack as a troubleshooting step.
3. Pair `depends_on: condition: service_healthy` with a real protocol healthcheck (`pg_isready`, `redis-cli ping`, an HTTP readiness URL) and keep reconnect logic in the app; startup order is not runtime availability.
4. Publish only what must be public. `ports: ["5432:5432"]` binds all interfaces and Docker's NAT rules bypass ufw's INPUT chain; omit `ports` for internal services or bind `127.0.0.1:5432:5432`.
5. Keep secrets out of committed `.env` and `compose.yaml`; mount them with top-level `secrets:` (`/run/secrets/<name>`) or an untracked env file, and redact config before sharing it.
6. Pin images by tag and preferably digest; record the previous digest before `pull` so rollback is an edit plus `up -d`.
7. Set log rotation (`logging` with `max-size`/`max-file`, or the `local` driver); default json-file logs grow until the disk fills.
8. Changing a database image major version on an existing volume is a migration (dump/restore or pg_upgrade), never a tag bump.

## First moves by situation

| Situation | First moves |
|---|---|
| Service exits or restarts | `docker compose ps -a`; `docker compose logs --since 15m --tail 200 <svc>`; exit code and `OOMKilled` via `docker inspect`; then container-debugging |
| "dependency failed to start: container is unhealthy" | `docker inspect --format '{{json .State.Health}}' <container>`; run the test command with `docker compose exec`; check `$$` escaping and `start_period` |
| Data "disappeared" | `docker compose ls`, `docker volume ls`; was the project name or directory different, or `-v` used? Map volumes before creating anything |
| Override not applied | `docker compose -f compose.yaml -f compose.prod.yaml config`; lists like `ports` merge by appending; use `!reset` or `!override` |
| Port reachable from the internet | `ss -tlnp`, `docker compose port <svc> <port>`; rebind to 127.0.0.1 or drop `ports`; re-test from outside |
| Wrong value inside a container | `.env` feeds interpolation in the file; `env_file:` and `environment:` feed the container; compare `docker compose config` with the image `ENV` |
| Host disk full | `docker system df -v`; size of `/var/lib/docker/containers/*/*-json.log`; add rotation; do not prune volumes |
| Update or roll back one service | Pin the new digest; `docker compose pull <svc>`; `docker compose up -d --no-deps --wait <svc>`; keep the old digest for rollback |

## Patterns and pitfalls

- **Project name drift** — the default project name is the project directory's basename; running from another directory, `-p` or `COMPOSE_PROJECT_NAME` creates a fresh `<newname>_pgdata` and an apparently empty database. Pin `name:` at the top of `compose.yaml`.
- **Interpolation escapes** — Compose interpolates `$VAR` in the file; a healthcheck that needs the container's variable must write `$$POSTGRES_USER`. Use `${VAR:?message}` to fail fast on missing required values.
- **Variable precedence** — shell environment beats `.env` for interpolation; in the container, `environment:` beats `env_file:` beats image `ENV`. Debug with `docker compose config`, not guesses.
- **Merge semantics** — with multiple `-f` files, mappings merge and many lists append; an override cannot remove a port or volume without `!reset` (or replace with `!override`) on a recent Compose.
- **One-shot migrations** — a `migrate` service with `restart: "no"` depending on `db: condition: service_healthy`, and the app depending on `migrate: condition: service_completed_successfully`.
- **`depends_on` extras** — `restart: true` restarts dependents when a dependency is restarted by Compose; `required: false` tolerates an absent optional service.
- **Bind mounts hide image content** — mounting `./app:/app` replaces the image's `/app` (including installed dependencies); named volumes are seeded from the image only when empty.
- **`docker compose run` differs from `up`** — it starts dependencies but does not publish ports unless `--service-ports`, and leaves containers unless `--rm`.
- **Default bridge has no DNS** — service-name resolution works on the project network; `network_mode: host` disables port mapping and service DNS for that service.
- **`container_name` blocks scaling** and parallel stacks; let Compose name containers.
- **Restart policies hide crash loops** — `restart: always` plus a failing app looks "Up" between crashes; check `RestartCount` in `docker inspect`.

## Workflow

1. Map services, dependencies, persisted state (named volumes, bind mounts), published ports and the project name.
2. Render and review the merged config for the target environment; diff it against the previous version.
3. Back up data-bearing volumes before risky changes (hand off to backup-recovery).
4. Apply the narrow change with `docker compose up -d --wait`, limited to the affected services where possible.
5. Verify health, inter-service DNS, the real application route, restart behaviour and data persistence.
6. Record the project name, files, image digests before and after, and the rollback command.

## Proof

- Validate: `docker compose config --quiet` (exit code) and a reviewed, redacted `docker compose config`
- Start: `docker compose up -d --wait --wait-timeout 120`; `docker compose ps -a`
- DNS and wiring: `docker compose exec <app> getent hosts db`
- App: `curl -fsS http://127.0.0.1:<port>/healthz` and the changed route
- Exposure: `ss -tlnp | grep <port>` shows 127.0.0.1 for internal services
- Persistence: `docker compose restart db` then the same row count or file listing as before
- Logs: `docker compose logs --since 10m <svc>` free of crash loops

## Stop and ask

- Any command that removes or recreates named volumes, changes the project name, or prunes Docker data.
- Database image major-version changes on an existing volume.
- Publishing a database, cache or admin UI port on a non-loopback interface.
- Applying changes to a production host, or reading and printing secret values.

## Before returning

- [ ] Merged config reviewed with the real files, profiles, project name and `.env`; no legacy `version:` key
- [ ] Healthchecks are real protocol checks; `depends_on` conditions match intent
- [ ] Internal services have no public `ports`, or bind 127.0.0.1; verified with `ss -tlnp`
- [ ] Images pinned; previous digests recorded for rollback
- [ ] Log rotation configured for long-running hosts
- [ ] `docker compose up -d --wait` healthy, app route answered, data survived a restart
- [ ] No volume deletion, prune or project rename performed without authorization

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Compose production](https://docs.docker.com/compose/how-tos/production/), [Engine releases](https://docs.docker.com/engine/release-notes/), [Compose releases](https://github.com/docker/compose/releases).

## Skills in scope

- docker-deploy — multi-stage Dockerfile authoring, build caching, image digests, and runtime entrypoint contracts.
- container-debugging — diagnose reported container build, startup, network, permission and resource failures.
- container-hardening — review and improve container image/runtime protection for an owned application with tested compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
- reverse-proxy-tls — the proxy in front of the stack and its loopback upstreams.
