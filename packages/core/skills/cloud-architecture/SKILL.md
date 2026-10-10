---
name: cloud-architecture
description: "Choose and design cloud services from concrete application, data, availability and operational requirements. Use when comparing AWS, Azure, GCP, Cloudflare or VPS architectures; preserve provider/account constraints and verify region-specific capabilities."
trigger: "Choose and design cloud services from concrete application, data, availability and operational requirements. Use when comparing AWS, Azure, GCP, Cloudflare or VPS architectures; preserve provider/account constraints and verify region-specific capabilities."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
---

# Cloud Architecture

## Selection card
- Task: Choose cloud topology, failure domains and services.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Choose and design cloud services from concrete application, data, availability and operational requirements.

Cloud products do not share one global latest version. Verify current service availability, quotas, runtime/SDK support and pricing from the selected provider before an architectural decision.

## Rules

1. Start from workload, latency, consistency, recovery, compliance constraints and operating capacity.
2. Compare concrete alternatives by data/identity/network boundaries and failure behavior, not provider marketing labels.
3. Define accountable data ownership, regions, exposure and access paths.
4. Estimate costs from explicit workload assumptions and dated provider rates; do not invent a monthly number.
5. Choose the simplest supported deployment/managed service shape that meets the requirements.
6. A design does not authorize account creation, provisioning, spending or production migration.

## Workflow

1. Map current architecture, requirements and fixed provider/region constraints.
2. Verify relevant current product/limit/pricing documentation.
3. Compare a few viable options with assumptions and operational tradeoffs.
4. Define contracts, failure/recovery model, rollout and observable acceptance.
5. For authorized implementation, hand the selected design into IaC/deployment and verify it.

## Before returning

Decision tied to requirements; provider/region facts sourced; cost assumptions visible; design versus provisioned/live outcome distinguished.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[AWS framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure architecture](https://learn.microsoft.com/en-us/azure/architecture/), [Google Cloud framework](https://cloud.google.com/architecture/framework).

## Skills in scope

- infrastructure-as-code — build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state.
- cloudflare-workers — build and maintain Cloudflare Workers with typed bindings, explicit compatibility and isolated validation.
- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
