---
name: incident-response
description: "Diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair."
trigger: "Diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Incident Response

## Selection card
- Task: Coordinate production outage triage and recovery.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair..

Use current deployed versions, platform limits and actual telemetry. Stored runbooks and prior incidents guide hypotheses but do not prove this incident cause.

## Rules

1. Define affected users/services, start time, severity and the current authorized response scope.
2. Capture deployment/config changes, focused telemetry and data boundary before disruptive actions.
3. Choose the smallest reversible mitigation supported by evidence; avoid blind restarts or repeated unbounded retries.
4. Keep one owner for deployment/data writers and record actions/timestamps.
5. Verify recovery through the user-facing path and relevant error/latency signals, not only process liveness.
6. Preserve sensitive evidence securely and redact incident reports; do not erase logs/backups to manufacture a clean state.

## Workflow

1. Establish impact, timeline and current health signals.
2. Localize the failing boundary and compare recent releases/configuration.
3. Execute authorized mitigation with a recovery/abort condition.
4. Verify service and data outcomes, then monitor the agreed window.
5. Document supported cause, actions, remaining risk and focused follow-up repairs.

## Before returning

Impact/timeline and actions recorded; mitigation scope clear; user-visible recovery checked; cause and remaining uncertainty separated.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[OpenTelemetry](https://opentelemetry.io/docs/), [Google SRE incident guidance](https://sre.google/sre-book/managing-incidents/).

## Skills in scope

- observability — observability contracts and verification.
- remote-debugging — diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
