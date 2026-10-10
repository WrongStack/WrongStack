---
name: container-hardening
description: "Review and improve container image/runtime protection for an owned application with tested compatibility. Use when reducing privileges, protecting secrets or setting container resource/exposure policies; do not label every hardening preference a confirmed vulnerability."
trigger: "Review and improve container image/runtime protection for an owned application with tested compatibility. Use when reducing privileges, protecting secrets or setting container resource/exposure policies; do not label every hardening preference a confirmed vulnerability."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "containers"
---

# Container Hardening

## Selection card
- Task: Reduce container privilege and secret exposure.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Review and improve container image/runtime protection for an owned application with tested compatibility.

Use current Docker/OCI/runtime documentation and the deployed platform version. Checked Docker target: 29.9.0; apply settings supported by the actual runtime.

## Rules

1. Map the application required capabilities, files, network access and persisted data before restricting it.
2. Use non-root execution, narrow writable paths and read-only filesystems where compatible.
3. Avoid privileged mode, unnecessary host mounts and daemon-socket access; document any real requirement.
4. Keep build/runtime credentials out of layers and logs; use supported secret mechanisms.
5. Bound memory/CPU/processes according to measured needs and verify graceful degradation.
6. Review image provenance/digests and advisory applicability; a scanner count alone does not determine release risk.

## Workflow

1. Inspect image/config and the actual exposure/ownership boundary.
2. Record current privileges and source-supported risks.
3. Apply a coherent narrow restriction set and rebuild/run the application.
4. Exercise startup, persistence, shutdown and necessary network/device operations.
5. Report implemented protections, compatibility checks and remaining justified privileges.

## Before returning

Privilege requirements explicit; secrets excluded; protected configuration tested; findings and optional improvements distinguished.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Docker security](https://docs.docker.com/engine/security/), [Build secrets](https://docs.docker.com/build/building/secrets/).

## Skills in scope

- security-scanner — review owned source, configuration and dependency metadata for supported security findings with precise evidence and remediation.
- docker-deploy — docker deploy contracts and verification.
- compose-operations — operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries.
- kubernetes-operations — operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity.
