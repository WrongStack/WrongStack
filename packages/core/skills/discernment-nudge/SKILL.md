---
name: discernment-nudge
description: "Pressure-test a high-stakes plan, architecture choice, cost estimate or security claim for hidden assumptions before delivering it. Use when a recommendation is consequential or hard to reverse — capacity or cost estimates, migrations, auth or crypto designs, failover plans, timelines — and an unstated assumption could sink it. Not for trivial edits or lookups, and not a substitute for proving code changes (use verify-before-done)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when about to deliver a consequential, hard-to-reverse recommendation, estimate or security claim."
metadata:
  routing-group: quality
---

# Discernment Nudge

## Selection card
- Task: Find and test the load-bearing assumptions in consequential advice before it is delivered.
- Start: List the claims the recommendation stands on and mark each verified, checkable now, or uncheckable.
- Finish: checkable assumptions were checked, the deliverable is complete, and at most three specific questions cover what only the user can answer.

## Overview

Consequential plans fail on an assumption nobody wrote down, so before delivering one, name the assumptions that would flip the decision, check the ones you can check yourself, and ask only about the rest.
The Discernment Nudge (reviewed 2026-11-02) applies three habits: ground facts in observed state, stress the reasoning where it leaps, and expose context the plan silently assumed.
It sharpens a deliverable; it never replaces or delays it.

## Rules

1. Deliver the complete requested plan or answer first; the check follows it and never withholds it.
2. Verify before asking: if an assumption can be checked with available tools (read the config, query the schema, measure the size, look up the limit), check it and state the result instead of asking.
3. Ask only about load-bearing assumptions — ones where being wrong changes the decision, the cost by a large factor, or the blast radius.
4. Every question names the specific component, number or failure mode and how to verify it (a command, query, dashboard or person).
5. At most three questions per consequential decision, and not again on later turns once the user has acknowledged the trade-off.
6. No generic caution ("test in staging", "monitor carefully"); if a sentence would fit any plan, delete it.
7. Skip the check for trivial, reversible or explicitly declined cases.

## When it applies

- **Estimates and projections** — cost, capacity, throughput, storage growth, timelines, SLAs.
- **Hard-to-reverse changes** — production data migrations, deletions, key rotations, breaking API changes, vendor lock-in.
- **Security and correctness claims** — "this is safe", "this cannot race", auth, crypto, multi-tenant isolation.
- **Architecture commitments** — sharding, consistency models, queues versus streams, multi-region and failover designs.

## Techniques

- **Assumption ledger** — list each claim the plan needs, with status: verified (cite evidence), checkable now (check it), uncheckable (candidate question).
- **Flip test** — for each assumption ask "if this were wrong, would I recommend something else?"; only flipping assumptions survive.
- **Pre-mortem** — imagine the plan failed in three months and write the most likely cause in one sentence; check whether the plan defends against it.
- **Reversibility** — classify the decision as one-way or two-way door; one-way doors need verified assumptions, two-way doors need a cheap rollback.
- **Ranges, not points** — estimates carry a low/likely/high range and the driver of the spread; anchor on a reference class (similar past migrations, measured rates) instead of intuition.
- **Sensitivity** — name the single input the result is most sensitive to (row count, request rate, egress volume) and where its real value comes from.
- **Second-order effects** — what else shares the resource: locks, connection pools, rate limits, budgets, on-call people.

## Output contract

After the full deliverable, append:

```markdown
### Discernment check
Verified: <assumption> — <evidence you gathered, e.g. "orders has 41M rows (SELECT count(*) on replica)">.
1. **Fact grounding**: <specific unverified fact, why it flips the plan, how to verify it>.
2. **Reasoning stress**: <where the plan leaps, what happens if wrong, the guard or fallback>.
3. **Missing context**: <constraint the plan assumed away, such as freeze windows, compliance or ownership>.
```

Omit the "Verified" line when nothing could be checked, and omit numbered items that have no load-bearing content.

## Examples of the bar

- Weak: "Make sure the database can handle the load."
- Strong: "The backfill assumes the primary sustains about 12k writes/s alongside normal traffic; the replica shows a 9k/s peak last week. If the primary cannot, replication lag grows and reads go stale — check write IOPS headroom on the primary's metrics for the last peak hour before scheduling."

## Skills in scope

- evidence-audit — proof-driven verification of security, performance and concurrency claims.
- verify-before-done — final completion gate and observable check reporting.
- sdd — specification-driven requirements and constraint discovery.
- research-web — current external facts, limits and prices from primary sources.
- data-governance — retention, PII and migration-safety assumptions.

## Acceptance checks

- [ ] The requested deliverable is complete before the check.
- [ ] Load-bearing assumptions identified with the flip test; checkable ones were actually checked and cited.
- [ ] At most three questions, each naming a concrete component, number or failure mode plus a way to verify.
- [ ] Estimates expressed as ranges with their main driver.
- [ ] No generic warnings; the check is absent for trivial or declined cases.
