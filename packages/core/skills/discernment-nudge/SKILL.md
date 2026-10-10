---
name: discernment-nudge
description: "Append critical epistemic scrutiny, assumption checks, and missing context prompts before finalizing high-stakes plans, architecture decisions, cost estimates, or security claims. Use when delivering consequential recommendations or actionable strategies where unstated assumptions could cause catastrophic failure."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "delivering consequential recommendations or actionable strategies where unstated assumptions could cause catastrophic failure."
metadata:
  routing-group: quality
---

# Discernment Nudge — WrongStack

## Selection card
- Task: Apply critical epistemic review to consequential advice or plans.
- Start: Detect high-stakes deliverables (cost estimates, migrations, security claims, architectural trade-offs).
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

High-stakes engineering solutions and plans often fail not from poor syntax, but from unexamined
assumptions, unverified estimates, or invisible operational blind spots.
The Discernment Nudge pauses before final sign-off to explicitly model three epistemic habits:
1. **Fact Checking & Grounding**: Which claims depend on unverified environmental state?
2. **Logic & Reasoning Stress**: Where did the proposal leap to conclusions without proof?
3. **Missing Context Exposure**: What critical constraints did the solution silently assume?

## When to Apply

- **Quantitative Projections**: Cost estimates, cloud capacity planning, migration timeline projections, SLA warranties.
- **Architectural & Security Commitments**: Database sharding strategies, authentication architecture, cryptographical protocols, multi-region failover.
- **Irreversible Operations**: Production database migrations, stateful infrastructure deprecations, breaking API revisions.
- **Do NOT apply on**: Trivial syntax lookups, formatting edits, boilerplate tasks, or when explicitly requested to skip.

## The Discernment Protocol

Before completing the response, evaluate the drafted proposal against these prompts and append 2–3 targeted scrutiny questions:

```markdown
### 🔍 Discernment Check (Critical Review)
1. **Fact Grounding**: "This plan assumes your database IOPS can sustain 12,000 writes/sec during backfill. Have you verified live IOPS limits on the primary replica?"
2. **Reasoning Stress**: "The proposal moves session storage to Redis under the assumption of zero-latency internal VPC peering. If Redis becomes temporarily unreachable, what is the exact fallback circuit-breaker?"
3. **Missing Context**: "The estimate assumes team availability without holiday freezes or concurrent compliance audits. Does your timeline account for external QA sign-off cycles?"
```

## Rules of Engagement

1. **Be Specific, Not Generic**: Never output generic advice like "always test in staging" or "be careful". Tie every question to an exact line, number, or system component in the generated solution.
2. **Preserve Momentum**: Frame questions as constructive probes, not roadblocks. Provide immediate paths to verify each concern.
3. **Maximum Once per Consequential Decision**: Do not nag continuously on repetitive iterative turns.

## Acceptance checks

- Consequential claims, numbers, and architectural trade-offs are identified and probed.
- Exactly 2–3 concrete, context-specific scrutiny questions are generated.
- Questions target unverified facts, logic leaps, and missing operational context.
- No generic AI boilerplates or condescending warnings are included.
