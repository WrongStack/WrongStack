---
name: cloud-architecture
description: "Cloud architecture on AWS, GCP, Azure, Cloudflare or a VPS: compute choice, data stores, networking, IAM, regions, failover and cost. Use when choosing services or topology, comparing serverless, containers and VMs, sizing for RPO/RTO, reviewing a design for cost or failure domains, or writing an architecture decision record. Not for writing Terraform (use infrastructure-as-code) or operating a live cluster (use kubernetes-operations)."
trigger: "Use when a request asks which cloud services, regions or topology to use, or why a cloud design is costly, fragile or non-compliant."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
---

# Cloud Architecture

## Selection card
- Task: Choose cloud topology, services, failure domains and cost model for a workload.
- Start: Write down the workload numbers (peak RPS, data size and growth, latency target, RPO/RTO, residency, team size) and fixed constraints (provider, account, region, budget).
- Finish: two or three compared options, a failure-domain and cost table with dated assumptions, and the decision recorded as an ADR.

## Overview

Choose the simplest topology whose failure modes the team can detect, operate and recover from, and justify it with workload numbers and dated provider facts rather than brand preference.
Cloud products do not share one global latest version. Verify current service availability, quotas, runtime/SDK support and pricing from the selected provider before an architectural decision.
Data placement and identity boundaries outlive compute choices; decide them first.

## Rules

1. Anchor every choice in numbers: peak and average RPS, payload size, data size and growth, read/write ratio, p95/p99 latency, RPO/RTO, residency and on-call capacity. When a number is unknown, state the assumption and what flips if it is wrong.
2. Name failure domains per component (process, instance, AZ, region, provider, account, credential) and what users and data experience when each fails. Multi-AZ is the default for stateful production; multi-region needs a stated requirement and a tested failover.
3. Decide the system of record and its consistency model before compute: relational for transactions and joins, key-value for known-key access at scale, object storage for blobs, a queue for buffered work.
4. Build cost from unit drivers with a date: compute hours or GB-seconds, requests, storage GB-month, IOPS, internet egress, cross-AZ and NAT GB, log ingestion, managed-service minimums.
5. Treat hard limits as design inputs: function duration and memory, DB connection limits, request/response size, API rate limits, per-account and per-region quotas. Verify current values in provider docs or quota APIs.
6. Separate accounts or projects per environment, workload identity (IAM roles, OIDC federation, managed identities) instead of static keys, least privilege per service. Blast radius is an architecture property.
7. Default to managed primitives in one region; Kubernetes, microservices, multi-cloud and active-active each need a named driver the team can operate.
8. A design never authorizes provisioning, commitments, spend or traffic migration; hand off to IaC with explicit approval.

## First moves by situation

| Situation | First moves |
|---|---|
| New service design | Fill the workload sheet; pick the system of record; draft options such as managed container platform + managed Postgres, functions + pooled DB, or one VPS + backups |
| Bill too high | Cost explorer grouped by service and usage type; look for NAT GB, cross-AZ GB, egress, idle provisioned capacity, log ingestion, orphaned snapshots and volumes |
| Serverless exhausting DB connections | Concurrency × pool size versus `max_connections`; add a pooler (RDS Proxy, PgBouncer, Hyperdrive) or cap concurrency |
| "Make it highly available" | Ask the availability, RTO and RPO targets; spread instances across AZs behind a health-checked LB, multi-AZ DB; test failover; price the delta |
| Disaster recovery / multi-region | Pick backup-restore, pilot light, warm standby or active-active from RTO/RPO; replication lag, write conflicts, DNS TTL, pre-provisioned capacity |
| Residency or compliance | Map where data at rest, backups, logs, replicas and support access land; check each managed service's regional behaviour |
| Edge, container or VM? | Request duration, CPU per request, in-memory state, long-lived connections, cold-start tolerance, native dependencies |
| Review an existing design | Draw request path and data flow; mark SPOFs, shared credentials, public endpoints, unbounded queues, untested backups |

## Patterns and pitfalls

- **NAT gateway tax** — private subnets reaching S3, ECR or DynamoDB through NAT pay per-GB processing; S3/DynamoDB gateway endpoints carry no charge, interface endpoints bill hourly plus per GB.
- **Cross-AZ chatter** — on AWS cross-AZ transfer is billed in each direction; replicas, brokers and service meshes spread across AZs multiply it. Model it, do not discover it on the bill.
- **Connection storms** — autoscaled functions or pods × pool size can exceed database limits during a spike or deploy; size pools from the database outward.
- **Fail-open health checks** — an AWS ALB routes to all targets when every target is unhealthy; a health check that queries the database can mark the whole fleet unhealthy on a DB blip. Keep liveness checks local, dependency checks separate.
- **Control-plane dependency in failover** — runbooks that need API calls in the failed region (scaling, DNS edits, IAM) fail with it; prefer data-plane failover: health-checked DNS records and pre-provisioned capacity.
- **Region skew** — instance types, GPUs, managed services and AI models are not in every region; verify in the chosen region before designing around them.
- **Low default quotas** — new accounts start with small vCPU, IP and function-concurrency quotas per region; request increases before launch, not during it.
- **Egress-heavy media** — internet egress dominates for downloads and video; put a CDN in front, and compare object stores (Cloudflare R2 has no egress fees but bills operations).
- **Same-account backups** — a compromised or deleted account takes its snapshots with it; copy backups to another account or provider (hand off to backup-recovery).
- **Kubernetes as a default** — minors ship roughly three times a year with about 14 months of support, so upgrades are permanent work; prefer Cloud Run, ECS Fargate, App Service or similar unless Kubernetes features are required.
- **Observability bill** — high-cardinality metrics and verbose logs at scale can rival compute; set sampling and retention in the design.

## Workflow

1. Capture requirements and constraints; list unknowns with their decision impact.
2. Draw the current or target request path and data flow; mark trust boundaries and public exposure.
3. Draft two or three options; for each list components, failure domains, limits that bind, operational burden and unit cost.
4. Verify every limit, price and regional-availability claim against provider docs or CLI output and record the date.
5. Recommend one option and write the ADR: context, decision, rejected alternatives and why, consequences, revisit trigger.
6. Hand provisioning to infrastructure-as-code with acceptance tests: load test, failover drill, restore drill.

## Proof

- Account identity before any read-only query: `aws sts get-caller-identity`, `gcloud config list`, `az account show`
- Quotas: `aws service-quotas list-service-quotas --service-code lambda`, `gcloud compute regions describe <region>`
- Cost: `infracost breakdown --path .` on the IaC, or a dated pricing-calculator export with the unit assumptions
- Capacity: `k6 run load.js` against a staging deployment at the stated peak
- Latency from user regions: `curl -s -o /dev/null -w '%{time_connect} %{time_starttransfer}\n' https://staging.example.com/healthz`
- Resilience: a staging game day that stops an instance or AZ dependency and measures recovery against the RTO

## Stop and ask

- Creating accounts or resources, buying reservations or savings plans, or any action that incurs spend.
- Migrating live traffic or data between regions, accounts or providers.
- Residency or compliance conclusions that need legal interpretation.
- A missing requirement (RPO/RTO, residency, budget) would flip the recommendation.

## Before returning

- [ ] Workload numbers, constraints and stated assumptions listed, with unknowns flagged
- [ ] Two or three options compared with failure domains, binding limits and operational burden
- [ ] System of record, consistency model, residency and backup location stated
- [ ] Network exposure and identity boundaries (accounts, roles, workload identity) mapped
- [ ] Cost itemized by unit drivers (compute, storage, egress, cross-AZ/NAT, observability) with a date
- [ ] Recommendation recorded as an ADR with rejected alternatives and a revisit trigger
- [ ] Design separated from provisioning; nothing created or migrated without approval

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[AWS framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure architecture](https://learn.microsoft.com/en-us/azure/architecture/), [Google Cloud framework](https://cloud.google.com/architecture/framework).

## Skills in scope

- infrastructure-as-code — build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state.
- cloudflare-workers — build and maintain Cloudflare Workers with typed bindings, explicit compatibility and isolated validation.
- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- backup-recovery — cross-account backup copies and restore drills that prove the stated RPO/RTO.
- observability — SLOs, telemetry cost and the signals that detect each failure domain.
