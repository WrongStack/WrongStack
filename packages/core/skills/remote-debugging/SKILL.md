---
name: remote-debugging
description: "Diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence. Use when local behavior differs from a known server or deployment; start read-only and keep diagnosis separate from disruptive remediation."
trigger: "Diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence. Use when local behavior differs from a known server or deployment; start read-only and keep diagnosis separate from disruptive remediation."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Remote Debugging

## Selection card
- Task: Diagnose remote processes and networking over SSH.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence.

Verify the actual runtime/package/container versions and source identity on the target; current host facts outrank assumptions from local builds.

## Rules

1. Pin the symptom, expected behavior, time window and affected authorized service.
2. Capture running process/image/revision, effective non-secret config and resource signals before proposing a fix.
3. Use bounded log/profile windows and minimize sensitive data capture; whole env dumps are not diagnostics.
4. Distinguish disk/memory/network/service conditions from application errors using evidence.
5. Preserve the live access path; restarts, tracing overhead and data changes need authorization within the maintenance task.
6. No broad discovery, third-party probing or access-control workarounds. A missing boundary is a diagnosis gap.

## Workflow

1. Connect through the approved SSH/observability surface.
2. Read service status, focused logs and relevant deployment/config differences.
3. Form one hypothesis and run the least disruptive bounded check.
4. Apply only requested/authorized remediation and verify the actual remote behavior.
5. Remove owned temporary instrumentation and state any remaining live risk/uncertainty.

## Before returning

Remote identity and symptom captured; evidence supports the cause; remediation scope and actual health stated; secrets/instrumentation handled.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[systemd journal](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html), [OpenTelemetry](https://opentelemetry.io/docs/).

## Skills in scope

- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- debugging — debugging contracts and verification.
- incident-response — diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair.
