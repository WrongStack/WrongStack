---
name: internal-comms
description: "Author clear, high-impact internal engineering communications including 3P status updates, blameless incident postmortems, architecture decision memos, and leadership briefs. Use when writing technical updates, sprint reports, incident reviews, or organizational engineering announcements."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "writing technical updates, sprint reports, incident reviews, or organizational engineering announcements."
metadata:
  routing-group: workflow
---

# Internal Comms — WrongStack

## Selection card
- Task: Author structured internal engineering communications and updates.
- Start: Identify communication format (3P, Postmortem, Executive Memo, Changelog) and audience.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

High-velocity engineering organizations thrive on crisp, transparent, and structured communication.
This skill establishes standardized formats for internal engineering reports, eliminating verbose fluff
and highlighting actionable facts, metrics, blockers, and timelines.

## Core Communication Formats

### 1. 3P Weekly / Sprint Update (Progress, Plans, Problems)
The standard cadence for asynchronous engineering visibility:
```markdown
# [Team/Project] Weekly 3P Update — Week WW (YYYY-MM-DD)

### 🟢 Progress (What Shipped)
- **Shipped**: Migrated auth session store to Redis cluster (PR #402). Latency p95 dropped from 120ms to 18ms.
- **Milestone**: Completed billing webhook idempotency key enforcement.

### 🟡 Plans (Next Sprint Commitments)
- Roll out OAuth2 PKCE flow to 10% canary traffic.
- Publish public API documentation for v2 webhooks.

### 🔴 Problems (Blockers & Asks)
- **Blocked**: Staging database replication lag waiting on Cloudflare tunnel certificate renewal (Ticket INFRA-912). Owner: @devops-lead.
- **Risk**: Third-party payment gateway sandbox has intermittent 504 errors, delaying integration tests.
```

### 2. Blameless Incident Postmortem
Focuses on systemic resilience, timeline precision, and preventive measures:
```markdown
# Incident Postmortem: [INC-XXXX] Service Degradation / Outage
- **Date**: YYYY-MM-DD | **Duration**: 42 minutes | **Severity**: SEV-1
- **Incident Commander**: @engineer | **Scribe**: @engineer

## Executive Summary
A memory leak in the WebSocket connection pool caused degraded response times for 14% of active users.

## Impact & Metrics
- Unhandled HTTP 500 errors: 3,420 requests.
- Customer financial impact: Zero data loss; checkout was delayed for ~120 transactions.

## Timeline (UTC)
- **14:02**: Alert triggered on high memory usage in `worker-edge-03`.
- **14:09**: Incident bridge opened; traffic rerouted to backup zone.
- **14:35**: Patch deployed reverting leaky connection recycling logic.
- **14:44**: Metrics stabilized; all health checks green.

## Root Cause Analysis (5 Whys)
Systemic exploration of triggers, defenses, and failure surfaces without personal blame.

## Action Items (Preventive Engineering)
| Item | Type | Owner | Ticket | Priority |
|---|---|---|---|---|
| Add memory soak test to CI | Prevention | @qa | QA-104 | P0 |
| Configure autoscaling alert threshold at 75% | Detection | @infra | INFRA-33 | P1 |
```

### 3. Architecture Decision Memo (Executive Brief)
One-page memo summarizing a strategic engineering choice for non-technical stakeholders or executives:
Context, Options Evaluated, Financial & Resource Impact, Decision, and Immediate Next Steps.

## Acceptance checks

- Communication strictly matches the designated format (3P, Postmortem, Architecture Memo).
- Jargon is demystified or tailored to the designated reader audience.
- Problems and blockers include explicit owners, status, and unblocking asks.
- Postmortems follow blameless philosophy and provide tracked preventive action items.
