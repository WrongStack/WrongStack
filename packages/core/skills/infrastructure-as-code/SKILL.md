---
name: infrastructure-as-code
description: "Build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state. Use when provisioning owned resources or fixing drift; preserve the project chosen engine, backend and provider contracts."
trigger: "Build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state. Use when provisioning owned resources or fixing drift; preserve the project chosen engine, backend and provider contracts."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
---

# Infrastructure As Code

## Selection card
- Task: Plan versioned Terraform or infrastructure changes.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state.

Checked 2026-10-09: Terraform 1.16.5, OpenTofu 1.13.1, Pulumi 3.268.0 and AWS CDK library 2.273.0. Verify engine/provider/backend compatibility and licensing before choosing or migrating.

## Rules

1. Pin account/subscription/project, region, workspace, backend and resource ownership.
2. Keep remote state access/locking and credentials explicit; state may contain secrets even when outputs are marked sensitive.
3. Review replacements, deletions, imports and data-bearing resources in the plan, not merely its exit code.
4. Separate plan from apply. Apply authorization must cover the actual environment and consequential operations.
5. Do not force-unlock, edit state or destroy resources as a generic response to contention/drift.
6. Pin providers/modules and refresh their supported APIs before upgrades; portability between engines is not automatic.

## Workflow

1. Inspect current configuration/state boundary and existing provider locks.
2. Resolve latest stable compatible engine/providers and implement the narrow change.
3. Run format/validate and a scoped plan, redacting sensitive output.
4. Review actual effects and perform only authorized apply/import/migration.
5. Verify resulting resource identity/health and reconciliation with state.

## Before returning

Environment/state ownership clear; plan effects reviewed; apply scoped; secrets protected and actual resource outcome reported.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Terraform state](https://developer.hashicorp.com/terraform/language/state), [OpenTofu docs](https://opentofu.org/docs/), [Pulumi docs](https://www.pulumi.com/docs/).

## Skills in scope

- cloud-architecture — choose and design cloud services from concrete application, data, availability and operational requirements.
- kubernetes-operations — operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity.
- ci-cd — build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
