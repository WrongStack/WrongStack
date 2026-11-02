---
name: container-debugging
description: "Docker container failures: build errors, exit codes 127/137/139, OOMKilled, exec format error, crash loops, DNS, ports, mounts. Use when an image fails to build, a container exits or restarts, a service is unreachable from the host or sibling containers, or an image behaves differently on another machine. Not for Compose wiring (use compose-operations) or privilege reduction (use container-hardening)."
trigger: "Use when a container exits, crash-loops, is OOMKilled, cannot be reached, or an image build fails or behaves differently on another host."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
---

# Container Debugging

## Selection card
- Task: Find the root cause of a container build, startup, network, permission or resource failure.
- Start: Capture `docker inspect` state (exit code, OOMKilled, restarts, health), bounded logs, and the exact image digest and platform that fails.
- Finish: the final-stage image starts cleanly from the same digest path, passes its health check, stops gracefully on SIGTERM, and the failing user path works.

## Overview

Read the container's recorded state before touching it: the exit code, OOM flag, health log and image platform usually name the failing layer, and guessing with restarts or prunes destroys that evidence.
Current checked engine target is Docker 29.9.2. Inspect actual daemon/client/build runtime and platform; build success and final-stage startup are separate checks.
Docker 29 raised the minimum API version to 1.44 and makes the containerd image store the default on new installs; old clients and SDKs fail with "client version is too old".

## Rules

1. Read before acting: `docker inspect --format '{{json .State}}' <ctr>` (ExitCode, OOMKilled, Error, Health) plus `docker logs --since 30m --tail 300 -t <ctr>`.
2. Reproduce with the exact failing image digest and platform (`docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}'`), not a fresh local build of a different commit.
3. Decode the exit code first: 125 the run command itself failed; 126 not executable; 127 command, interpreter or loader not found; 137 SIGKILL (OOMKilled=true means the memory limit, false means a stop timeout or external kill); 139 segfault (native module, libc or arch mismatch); 143 SIGTERM, a normal stop.
4. A server must bind `0.0.0.0` or `::` inside the container; `127.0.0.1` there is the container's own loopback and is unreachable through published ports or from siblings.
5. Bring tools beside the container instead of into the image: `docker run --rm -it --network container:<ctr> --pid container:<ctr> nicolaka/netshoot` shares its namespaces; distroless images have no shell.
6. Fix ownership with numeric UID/GID (`COPY --chown`, volume initialization), never `chmod -R 777`, `--privileged` or switching to root.
7. Preserve evidence: copy files out with `docker cp <ctr>:/path ./evidence` before removing anything; no prune, `down -v` or volume deletion as a fix.
8. Build and runtime are separate proofs: a green build says nothing about entrypoint, user, signals or health of the final stage.

## First moves by situation

| Situation | First moves |
|---|---|
| Exits immediately | State and logs; `docker image inspect --format '{{json .Config}}' <image>` for Entrypoint, Cmd, User, WorkingDir, Env names; `docker run --rm -it --entrypoint sh <image>` if a shell exists |
| `exec format error` | Image arch vs host `uname -m`; `docker buildx imagetools inspect <ref>` for available platforms; rebuild with `--platform` |
| "no such file or directory" for a file that exists | Missing dynamic loader (glibc binary on musl or scratch), or CRLF shebang; `head -1 entrypoint.sh \| od -c` |
| Exit 137 | `OOMKilled`; `HostConfig.Memory`; `docker stats --no-stream`; host `journalctl -k \| grep -i oom`; if not OOM, check PID 1 signal handling and stop timeout |
| Restart loop | `RestartCount`; `docker events --since 30m --filter container=<ctr>`; `docker logs` keeps output of earlier runs of the same container |
| Unreachable service | Listening address via netshoot `ss -tlnp`; `docker port <ctr>`; `docker inspect --format '{{json .NetworkSettings.Networks}}' <ctr>`; host firewall |
| Sibling DNS fails | Both on the same user-defined network? Embedded DNS (127.0.0.11) does not resolve names on the default bridge; `getent hosts <service>` |
| Permission denied on a mount | `docker exec <ctr> id`; `ls -ln` of the mount on host and inside; SELinux hosts need `:z`/`:Z` labels |
| Build fails or differs | `docker buildx build --progress=plain --target <stage> .`; `--no-cache-filter <stage>`; check `.dockerignore`; `docker buildx build --check .` |
| Throttled or slow | `docker stats`, `docker top <ctr>`; inside, `cat /sys/fs/cgroup/cpu.stat` (`nr_throttled`) and `memory.events` (`oom_kill`) |

## Patterns and pitfalls

- **Shell-form PID 1** — `CMD node server.js` runs under `/bin/sh -c`, which does not forward SIGTERM; `docker stop` waits 10 s then SIGKILLs (137). Use exec form, `exec "$@"` in entrypoint scripts, and `--init` (tini) when the app spawns children.
- **Package-manager PID 1** — `npm start` and similar wrappers do not reliably forward signals; start the runtime directly.
- **Missing loader** — a glibc or CGO binary copied into Alpine or scratch reports "not found"; build static (`CGO_ENABLED=0`) or match the base image's libc.
- **CRLF scripts** — a Windows checkout gives `/bin/sh^M: not found`; enforce `*.sh text eol=lf` in `.gitattributes`.
- **Arch drift** — Apple Silicon builds arm64 by default; amd64 servers then fail with `exec format error`, and QEMU emulation can crash native modules. Build and test the target platform.
- **Runtime memory sizing** — runtimes sized from host RAM exceed the container limit; set heap caps below the limit (Node `--max-old-space-size`, JVM `-XX:MaxRAMPercentage`).
- **Healthcheck without tools** — slim and distroless images lack curl and wget, so health fails while the app is fine; use a built-in health subcommand or orchestrator probe.
- **Volume shadowing** — a bind mount over the app directory hides installed dependencies baked into the image.
- **Stale image** — `up` and `run` reuse a cached tag; compare the running container's image ID with the registry digest before concluding a fix did not work.
- **Disk exhaustion** — `no space left on device` often comes from build cache or unrotated json logs; inspect with `docker system df -v` and `docker buildx du`.

## Workflow

1. Record context: Docker context, host, image digest, platform, run flags or Compose service, resource limits.
2. Read state, health log and bounded logs; classify the failure as build, start, network, permission or resource.
3. Form one hypothesis and test it with the least disruptive check (inspect, side-car namespace, throwaway container from the same image).
4. Make the narrow Dockerfile, config or application change.
5. Rebuild the final stage, run it as production does, and check health, graceful stop and the failing path.
6. Report the root cause with evidence and what was left untouched.

## Proof

- Build: `docker buildx build --progress=plain -t app:debug .`
- Platform: `docker image inspect --format '{{.Os}}/{{.Architecture}}' app:debug`
- Start: `docker run -d --name app-debug -p 127.0.0.1:8080:8080 app:debug`, then `curl -fsS http://127.0.0.1:8080/healthz`
- State: `docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}} {{.RestartCount}} {{.State.Health.Status}}' app-debug`
- Graceful stop: `time docker stop app-debug` returns well under the 10 s timeout with exit code 0 or 143
- Cleanup: `docker rm app-debug` for the throwaway container you created

## Stop and ask

- Removing, recreating or pruning containers, images or volumes on a shared or production host.
- Restarting production containers or changing their restart policy, limits or networks.
- Using `--privileged`, host network or PID namespaces, or mounting the Docker socket, even temporarily.
- Attaching a debug side-car or packet capture to a production container that sees secrets or user traffic.

## Before returning

- [ ] Docker context, image digest, platform and container `State` (ExitCode, OOMKilled, RestartCount, Health) recorded
- [ ] Root cause traced to a specific layer, entrypoint/signal form, bind address, libc/loader, arch, permission or resource limit
- [ ] Fix verified on the final runtime stage: clean start, healthy, graceful SIGTERM stop
- [ ] No `chmod 777`, `--privileged`, root user or restart-loop masking introduced
- [ ] Data volumes and unrelated containers untouched; throwaway containers removed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Docker troubleshooting](https://docs.docker.com/engine/daemon/troubleshoot/), [Docker build practices](https://docs.docker.com/build/building/best-practices/), [Engine v29](https://www.docker.com/blog/docker-engine-version-29/).

## Skills in scope

- docker-deploy — multi-stage Dockerfile structure, layer caching, and production image builds.
- compose-operations — operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- debugging — isolate application-level defects once container runtime/environment causes are ruled out.
- kubernetes-operations — the same failures inside pods: `kubectl describe`, previous logs and ephemeral debug containers.
