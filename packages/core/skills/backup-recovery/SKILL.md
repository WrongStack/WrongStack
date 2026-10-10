---
name: backup-recovery
description: "Design and verify backups and restoration for owned databases, files and application state. Use when preparing recovery, migrating data or testing backups; protect the source and prove restore into an isolated destination before calling recovery ready."
trigger: "Design and verify backups and restoration for owned databases, files and application state. Use when preparing recovery, migrating data or testing backups; protect the source and prove restore into an isolated destination before calling recovery ready."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Backup Recovery

## Selection card
- Task: Prove backup restore and recovery objectives.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Design and verify backups and restoration for owned databases, files and application state.

Use the data engine/platform current supported backup and restore format. Checked PostgreSQL stable target: 18.6; verify tool/server compatibility and recovery semantics before database operations.

## Rules

1. Define protected data, ownership, retention, recovery-point/time objectives and credentials.
2. Distinguish logical dump, physical snapshot, filesystem copy and replication; they provide different consistency guarantees.
3. Verify encryption/access and off-host storage; backup existence or upload success is not restore proof.
4. Restore into a checked isolated destination and validate counts, constraints, attachments and application behavior.
5. Avoid overwriting live databases or deleting retained backups without explicit recovery/retention authorization.
6. Record partial recovery and missing time ranges; do not imply a newer backup can restore data it never captured.

## Workflow

1. Inventory stores and dependencies needed for a coherent recovery point.
2. Configure the appropriate backup workflow with bounded operational impact.
3. Verify completion metadata, integrity and access from the recovery environment.
4. Restore a representative backup into isolation and run data/application checks.
5. Document tested commands, timing, recovered scope and the live cutover boundary.

## Before returning

Backup provenance/time/integrity known; isolated restore actually ran; application/data checks passed; source and retention preserved.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[PostgreSQL backup](https://www.postgresql.org/docs/current/backup.html), [PostgreSQL versioning](https://www.postgresql.org/support/versioning/).

## Skills in scope

- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- data-governance — data governance contracts and verification.
- storage-uploads — implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle.
- incident-response — diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair.
