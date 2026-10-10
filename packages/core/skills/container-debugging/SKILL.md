---
name: container-debugging
description: "Diagnose reported container build, startup, network, permission and resource failures. Use when an image or Compose service fails; reproduce against the final image/config and avoid data-destroying cleanup as a workaround."
trigger: "Diagnose reported container build, startup, network, permission and resource failures. Use when an image or Compose service fails; reproduce against the final image/config and avoid data-destroying cleanup as a workaround."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
---

# Container Debugging

## Selection card
- Task: Diagnose a running container failure.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Diagnose reported container build, startup, network, permission and resource failures.

Current checked engine target is Docker 29.9.0. Inspect actual daemon/client/build runtime and platform; build success and final-stage startup are separate checks.

## Rules

1. Pin Docker context, container/image digest, platform, effective command and environment.
2. Distinguish build-stage dependencies from final runtime files, dynamic libraries and writable paths.
3. Inspect exit code, focused logs and health command before changing timeout/restart policy.
4. Check namespace-specific network/DNS assumptions and service names on the actual network.
5. Diagnose UID/GID and bind-volume permissions without broadly making paths world-writable.
6. Keep production data/images/evidence intact; cache deletion, pruning and volume removal require a specific supported reason.

## Workflow

1. Reproduce the failure with the exact image/config and bounded checks.
2. Trace build output or startup failure to the responsible layer/path.
3. Compare working local conditions with the image/host platform.
4. Make the narrow Dockerfile/config/application repair.
5. Rebuild/run the final stage and verify health, signals and the failing user path.

## Before returning

Correct context/image/config tested; cause backed by logs/state; final-stage behavior verified; data and unrelated containers preserved.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Docker troubleshooting](https://docs.docker.com/engine/daemon/troubleshoot/), [Docker build practices](https://docs.docker.com/build/building/best-practices/).

## Skills in scope

- docker-deploy — docker deploy contracts and verification.
- compose-operations — operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- debugging — debugging contracts and verification.
