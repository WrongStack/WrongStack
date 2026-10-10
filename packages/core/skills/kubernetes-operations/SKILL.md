---
name: kubernetes-operations
description: "Operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity. Use when configuring Deployments, Services, probes, resources or diagnosing a known workload; do not expand an application task into uncontrolled cluster administration."
trigger: "Operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity. Use when configuring Deployments, Services, probes, resources or diagnosing a known workload; do not expand an application task into uncontrolled cluster administration."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
---

# Kubernetes Operations

## Selection card
- Task: Operate Kubernetes workloads and autoscaling.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity.

Checked stable Kubernetes target: 1.37.1 on 2026-10-09. Verify managed-provider support, API versions, client/server skew and addon compatibility before upgrades.

## Rules

1. Pin kube context, cluster, namespace, workload and authorized operations before reading or changing resources.
2. Use versioned manifests/images and inspect the actual diff/plan before apply.
3. Separate startup, readiness and liveness; a failing dependency should not create a destructive restart loop by default.
4. Define resource requests/limits and rollout/disruption behavior from workload needs.
5. Keep Secrets, service accounts, access policy and storage ownership explicit; do not print secret payloads or delete volumes for troubleshooting.
6. Confirm rollout completion and user-route behavior; applied manifests are not deployed-service proof.

## Workflow

1. Inspect the named workload, events, focused logs and effective deployment configuration.
2. Resolve stable platform/API compatibility and the narrow repair/rollout.
3. Validate manifests and preview changes in the exact target context.
4. Perform authorized apply/rollout and observe probes, replica/version identity and application requests.
5. Report rollout/recovery and persistent data boundary separately.

## Before returning

Context/namespace/workload explicit; API/skew support checked; rollout and user behavior observed; data and unrelated workloads preserved.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Kubernetes releases](https://kubernetes.io/releases/), [Deployment contract](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

## Skills in scope

- container-hardening — review and improve container image/runtime protection for an owned application with tested compatibility.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- observability — observability contracts and verification.
- infrastructure-as-code — build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state.
