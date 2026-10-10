---
name: release-rollback
description: "Plan and execute authorized release promotion or rollback with exact artifact and data compatibility. Use when deploying versions, changing traffic or recovering a bad release; do not equate reversing code with restoring data."
trigger: "Plan and execute authorized release promotion or rollback with exact artifact and data compatibility. Use when deploying versions, changing traffic or recovering a bad release; do not equate reversing code with restoring data."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
---

# Release Rollback

## Selection card
- Task: Verify release promotion and rollback paths.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Plan and execute authorized release promotion or rollback with exact artifact and data compatibility.

Read [promotion and recovery](references/promotion.md) for a consequential release. Use current platform rollout/version APIs and supported image/runtime targets.

## Rules

1. Pin source revision, artifact digest/build id, config identity and target environment.
2. Define user-facing success/failure signals, observation window and rollback trigger before promotion.
3. Verify old/new code compatibility with current schema, messages and persistent state.
4. Keep promotion idempotent and scoped; avoid overlapping deploy writers or conflicting traffic updates.
5. Preserve a recoverable prior artifact/config and identify state that rollback cannot reverse.
6. A release plan/check result does not authorize publishing; actual promotion and rollback follow current user authorization.

## Workflow

1. Capture current deployment and prepare the exact new artifact.
2. Validate compatibility and recovery in an isolated environment.
3. Promote using the supported platform strategy and observe the agreed signals.
4. If authorized rollback conditions hold, restore the known compatible artifact/config.
5. Verify user path and release identity after either action; report remaining data repair separately.

## Before returning

Artifact/environment identity recorded; promotion evidence and recovery compatibility verified; live health and data limitations explicit.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Cloudflare deployment versions](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/), [Kubernetes deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

## Skills in scope

- ci-cd — build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates.
- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- incident-response — diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair.
