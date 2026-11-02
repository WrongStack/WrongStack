---
name: container-hardening
description: "Container hardening in Dockerfiles, Compose and pods: non-root USER, cap_drop, read-only rootfs, build secrets, digests, CVE scans. Use when reducing container privileges, removing secrets from images, slimming and pinning bases, triaging Trivy, Grype or Docker Scout findings, or meeting Pod Security restricted. Not for crash diagnosis (use container-debugging) or application-code vulnerabilities (use security-scanner)."
trigger: "Use when a request asks to harden, slim or secure a container image or runtime config, or to triage image CVE scanner output."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
---

# Container Hardening

## Selection card
- Task: Reduce container privilege, attack surface and secret exposure without breaking the app.
- Start: Inspect the image config (`docker image inspect`), `docker history --no-trunc`, the Dockerfile and the runtime spec (Compose service or pod spec) as deployed.
- Finish: the hardened container starts, serves a real request and stops gracefully under the new restrictions, and findings are split into confirmed issues and hardening advice.

## Overview

Hardening is a set of restrictions proven against the app's real start, request and shutdown paths; a restriction that silently breaks the app gets reverted, so measure what the process needs before taking anything away.
Use current Docker/OCI/runtime documentation and the deployed platform version. Checked Docker target: 29.9.2; apply settings supported by the actual runtime.
Scanner counts are inputs, not verdicts: what matters is what ships in the final stage and is reachable.

## Rules

1. Inventory runtime needs first (listening ports, written paths, outbound hosts, devices, native libraries, capabilities), then restrict, and retest startup, a real request and `docker stop` after each change.
2. Run as a numeric non-root user (`USER 10001:10001`); Kubernetes `runAsNonRoot` cannot verify a named user and refuses to start it. Application code stays owned by root and read-only; only data paths belong to the app user.
3. Drop all capabilities and add back only proven ones; set `no-new-privileges`; keep the default seccomp/AppArmor profile. Never `privileged`, host PID/network/IPC, or a Docker socket mount for application workloads (the socket is root on the host).
4. Keep secrets out of layers and metadata: BuildKit `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc`, runtime secrets as mounted files, `.env` and keys listed in `.dockerignore`. `ARG` and `ENV` values persist in history and image config.
5. Use a read-only root filesystem with explicit `tmpfs` for scratch paths, plus memory, CPU and `pids_limit` limits.
6. Ship a minimal final stage (multi-stage build; distroless, Wolfi/Chainguard or scratch for static binaries) pinned by digest, and automate digest bumps; a pinned base never receives patches on its own.
7. Triage scanner findings by final-stage presence, reachability and fix availability; report confirmed vulnerabilities separately from defence-in-depth recommendations.
8. Where the platform verifies supply chain, build with SBOM and provenance and sign by digest; verify signatures at deploy, not only at build.

## First moves by situation

| Situation | First moves |
|---|---|
| Review a Dockerfile or service | `docker image inspect --format '{{.Config.User}} {{json .Config.ExposedPorts}}' <img>`; `docker history --no-trunc <img>`; runtime security fields in Compose or pod spec |
| Scanner shows hundreds of CVEs | `trivy image --severity HIGH,CRITICAL --ignore-unfixed <img>`; which packages are in the final stage; bump the base first; record not-affected cases (VEX) |
| Secret found in an image | Treat as leaked: rotate it first (pulled copies keep the layer); rebuild with secret mounts; remove registry tags only with approval |
| Move to non-root or read-only rootfs | Run the app, exercise it, then `docker diff <ctr>` lists every path it wrote; give those tmpfs or volumes |
| Image needs port 80 as non-root | Docker sets `net.ipv4.ip_unprivileged_port_start=0` in container namespaces by default (not with host networking); Kubernetes does not, so listen on 8080 and map |
| Official DB or proxy image breaks with `cap_drop: [ALL]` | Images that start as root and step down need `CHOWN`, `SETUID`, `SETGID`; or run as the target user with pre-owned volumes |
| Kubernetes Pod Security | `restricted` needs `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `seccompProfile.type: RuntimeDefault`; preview with `kubectl apply --dry-run=server` warnings |
| CI or proxy wants the Docker socket | Prefer a socket proxy exposing a read-only API allowlist, rootless Docker, or a different integration; document the residual risk |

## Patterns and pitfalls

- **Deleted files stay in layers** — `RUN rm /root/.npmrc` in a later layer leaves the secret in the earlier one; only secret mounts or a non-shipped build stage avoid it.
- **Provenance leaks build args** — `--provenance=mode=max` records build arguments in the attestation; never pass secrets as `ARG`.
- **`COPY . .`** — without a tight `.dockerignore` it ships `.git`, `.env`, private keys and local caches.
- **Writable code** — if the app user owns its own code, any RCE can persist by editing it; copy code as root-owned and read-only.
- **tmpfs flags** — `noexec` on `/tmp` breaks runtimes and libraries that unpack native code there; test, and document the exception rather than dropping the restriction everywhere.
- **Distroless healthchecks** — no shell, curl or wget; use a built-in health subcommand (`["/app/server", "healthcheck"]`) or an orchestrator probe.
- **UID change on existing volumes** — switching `USER` leaves old files owned by root; plan a one-time ownership migration instead of `chmod 777`.
- **Digest rot** — pinned digests are reproducible but stale; pair them with Renovate or Dependabot digest updates and scheduled rebuilds.
- **Scanner blind spots** — vendored, statically linked or copied binaries without package metadata are invisible to most scanners; an SBOM from the build helps.
- **User namespaces** — rootless Docker or `userns-remap` maps container root to an unprivileged host UID; in Kubernetes check the cluster version for `hostUsers: false` support.
- **Mutable tags** — deploy by digest; a tag can be repointed after review.

## Workflow

1. Record the current image, runtime flags, exposure (published ports, networks) and the owning platform.
2. Observe needs: run the app, exercise its main paths, then `docker diff`, open ports and required capabilities.
3. Apply a coherent restriction set in the Dockerfile and runtime spec; keep one commit per class of change when possible.
4. Rebuild, scan, and run with the new restrictions; exercise start, request, persistence and graceful stop.
5. Re-scan and compare findings before and after; note remaining justified privileges.
6. Report confirmed vulnerabilities, implemented protections, compatibility evidence and open exceptions.

## Proof

- User: `docker image inspect --format '{{.Config.User}}' <img>` is numeric and non-zero; `docker exec <ctr> id`
- Layers: `docker history --no-trunc <img>` shows no tokens, passwords or keys
- Runtime: `docker run --rm -d --name hardened --read-only --tmpfs /tmp:rw,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 --memory 512m -p 127.0.0.1:8080:8080 <img>` then `curl -fsS http://127.0.0.1:8080/healthz` and `docker stop hardened`
- Effective privileges: `docker inspect --format '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.ReadonlyRootfs}}' hardened`; with a shell, `grep -E 'CapEff|NoNewPrivs' /proc/1/status`
- Scan: `trivy image --severity HIGH,CRITICAL <img>`, `grype <img>` or `docker scout cves <img>`, before and after
- Supply chain: `docker buildx build --sbom=true --provenance=mode=min ...`; `cosign verify <img>@sha256:<digest>` with the platform's key or identity
- Kubernetes: `kubectl apply --dry-run=server -f <manifest>` with no Pod Security warnings

## Stop and ask

- A leaked credential needs rotation or revocation, or registry tags or images would be deleted.
- A change alters the runtime UID on volumes holding existing data.
- Rolling hardened images or new runtime restrictions to production.
- Any request to grant `privileged`, host namespaces, the Docker socket, or to disable seccomp/AppArmor.
- A finding would be reported as exploitable without reachability evidence.

## Before returning

- [ ] No secrets in Dockerfile `ARG`/`ENV`, `docker history`, image config or copied files
- [ ] Numeric non-root user; code read-only; only data paths writable
- [ ] `cap_drop: [ALL]` (with justified add-backs), `no-new-privileges`, default seccomp, no host namespaces or socket
- [ ] Read-only rootfs, tmpfs paths, and memory/CPU/PID limits verified against start, request and graceful stop
- [ ] Base pinned by digest with an update path; final stage free of compilers and package managers
- [ ] Scanner results before/after attached; confirmed vulnerabilities separated from hardening advice

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Docker security](https://docs.docker.com/engine/security/), [Build secrets](https://docs.docker.com/build/building/secrets/), [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).

## Skills in scope

- security-scanner — review owned source, configuration and dependency metadata for supported security findings with precise evidence and remediation.
- docker-deploy — multi-stage Dockerfile construction, BuildKit caching, and runtime entrypoint setup.
- compose-operations — operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries.
- kubernetes-operations — operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity.
- container-debugging — when a restriction breaks startup and the cause needs isolating.
