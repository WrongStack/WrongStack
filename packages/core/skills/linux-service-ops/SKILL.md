---
name: linux-service-ops
description: "Configure and troubleshoot application services on an authorized Linux host with explicit service ownership. Use when managing systemd units, startup, logs, users, permissions or service resources; preserve the administrator existing distro configuration."
trigger: "Configure and troubleshoot application services on an authorized Linux host with explicit service ownership. Use when managing systemd units, startup, logs, users, permissions or service resources; preserve the administrator existing distro configuration."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Linux Service Ops

## Selection card
- Task: Operate Linux services, journals and resource limits.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Configure and troubleshoot application services on an authorized Linux host with explicit service ownership.

Checked upstream systemd release: 262 (2026-10-09). Use the distro-supported systemd package and its actual unit directives; upstream latest does not justify replacing the host OS service manager.

## Rules

1. Identify the exact unit, host, user, environment and current process before editing.
2. Separate reload, restart, enable and start: they change different service states.
3. Preserve the working access path and inspect dependent services before disruptive changes.
4. Keep unit credentials/environment secret references outside source and redact logs at the report boundary.
5. Validate unit syntax and runtime paths/permissions before restart; ExecStart parsing is not an ordinary shell.
6. Scope resource/sandbox limits to actual application needs and verify writable directories and shutdown behavior.

## Workflow

1. Read the target unit/effective overrides, relevant journal window and process status.
2. Identify the narrow configuration or application cause; prepare an owned drop-in or source fix.
3. Validate, reload definitions where needed and perform the authorized service transition.
4. Confirm new process/version, readiness, logs and clean stop/restart.
5. Report changes, downtime/recovery boundary and persistent enablement state.

## Before returning

Correct service/process identified; unit validation performed; running version/readiness checked; owned overrides and recovery recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[systemd service contract](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd releases](https://github.com/systemd/systemd/releases).

## Skills in scope

- ssh-operations — verified authorized remote connection.
- remote-debugging — bounded evidence on the authorized host.
- observability — runtime signals and correlation.
- release-rollback — version promotion and recovery compatibility.
