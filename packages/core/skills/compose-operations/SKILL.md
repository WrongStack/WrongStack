---
name: compose-operations
description: "Operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries. Use when wiring services, health dependencies or production overrides; use docker-deploy for image construction."
trigger: "Operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries. Use when wiring services, health dependencies or production overrides; use docker-deploy for image construction."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
---

# Compose Operations

## Selection card
- Task: Operate multi-service Docker Compose dependencies.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries.

Checked targets 2026-10-09: Docker Engine 29.9.0 and Compose 5.6.0. Verify installed plugin/engine support and release notes; do not introduce a legacy top-level compose version key.

## Rules

1. Inspect the effective merged config, project name and environment before any operation.
2. Separate named data volumes, bind mounts and ephemeral container state; preserve data ownership.
3. Health/dependency startup conditions do not prove ongoing availability or application-level readiness.
4. Restrict published ports and network membership to the intended exposure; a container localhost is not another service.
5. Keep secrets outside committed env/config and inspect interpolation without printing credential values.
6. Do not use down -v, prune or force recreation as a generic troubleshooting step on a data-bearing environment.

## Workflow

1. Map service dependencies, persisted state, ports and start/stop requirements.
2. Validate the merged configuration and latest compatible Compose semantics.
3. Start/update the authorized services and inspect actual health/logs.
4. Test application connectivity, restart behavior and data persistence.
5. Record effective environment, changed services and rollback/data boundary.

## Before returning

Effective project/config identified; persisted volumes protected; readiness and inter-service requests verified; destructive cleanup not implicit.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Compose production](https://docs.docker.com/compose/how-tos/production/), [Engine releases](https://docs.docker.com/engine/release-notes/), [Compose releases](https://github.com/docker/compose/releases).

## Skills in scope

- docker-deploy — docker deploy contracts and verification.
- container-debugging — diagnose reported container build, startup, network, permission and resource failures.
- container-hardening — review and improve container image/runtime protection for an owned application with tested compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
