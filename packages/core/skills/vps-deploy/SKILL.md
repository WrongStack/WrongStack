---
name: vps-deploy
description: "Deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence. Use when publishing or repairing a known server deployment; preserve existing services and separate local preparation from remote execution."
trigger: "Deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence. Use when publishing or repairing a known server deployment; preserve existing services and separate local preparation from remote execution."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
---

# Vps Deploy

## Selection card
- Task: Release an application on an existing VPS.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.

Resolve current stable application/runtime targets through tech-stack, then verify host OS/architecture and supported packages. Do not replace an entire host toolchain merely because upstream released a newer version.

## Rules

1. Pin authorized host, account, application, domain, release revision and target environment.
2. Build the exact artifact and include runtime assets/config references; credentials remain in the approved remote mechanism.
3. Use versioned release directories or image digests and an explicit promotion step; keep prior release identity recoverable.
4. Verify runtime binding, service user, writable paths and reverse-proxy routing before traffic promotion.
5. Couple schema changes to a compatibility/recovery plan; switching the app back cannot undo irreversible data changes.
6. Deploy/restart/route changes only as authorized by the task; prepare and validate local work first when deployment approval remains outstanding.

## Workflow

1. Inspect existing deployment/service and capture current release/health.
2. Verify latest stable targets, build and run the artifact locally or in an isolated equivalent.
3. Transfer/pull the versioned artifact to the known authorized target and validate ownership/config.
4. Start/health-check the new release, then perform the authorized promotion.
5. Verify live user path, service version and logs; retain prior release for the defined rollback window.

## Before returning

Host/environment and artifact identity explicit; live service version/health observed; local and remote proof separated; rollback/data boundary recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [Docker production](https://docs.docker.com/compose/how-tos/production/).

## Skills in scope

- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- linux-service-ops — configure and troubleshoot application services on an authorized Linux host with explicit service ownership.
- reverse-proxy-tls — configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
