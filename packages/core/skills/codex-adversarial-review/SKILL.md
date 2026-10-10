---
name: codex-adversarial-review
description: |
  Use this skill to conduct aggressive, adversarial code reviews on git changes, branches, or PRs to detect critical edge cases, race conditions, security holes, and data loss risks.
  Triggers: user mentions "adversarial review", "break the code", "find vulnerabilities", "security audit PR", "race condition check", "ship gate", "pre-merge audit".
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [version-control.manage]
trigger: "Use this skill to conduct aggressive, adversarial code reviews on git changes, branches, or PRs to detect critical edge cases, race conditions, security holes, and data loss risks."
metadata:
  routing-group: quality
---

# Codex Adversarial Code Review Architecture

## Selection card
- Task: Review adversarially and propose approval-gated fixes.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

The purpose of an adversarial code review is not to validate the author's work, but to aggressively break confidence in the change by uncovering subtle, high-cost, or user-visible failure modes before the code reaches production. Reviewers adopt the mindset of an attacker, a chaotic network environment, and an overloaded database.

## Rules

1. **Pre-flight: Inspect repo diff & live security advisories first.** Read the full git diff, surrounding call sites, and recent dependency changes in `package.json` / lockfiles. Cross-reference suspicious patterns or third-party packages against live security advisories (e.g. GitHub Advisory Database, CVE feeds) before auditing logic.
2. Default to skepticism. Assume the change fails in high-risk ways until concrete evidence proves safety.
3. Focus on high-damage attack surfaces: auth boundaries, tenant isolation, data loss/corruption, idempotency gaps, and race conditions.
4. Ignore superficial style, formatting, and naming feedback; report only material, high-impact defects.
5. Strict Stop Rule: After presenting review findings, STOP. Never modify code or auto-apply fixes without explicit confirmation from the user.
6. Issue a clear ship decision: `BLOCKING_RISKS_DETECTED` if blocking risks exist, or `APPROVE` only if no substantive flaws can be proven.
7. Construct reproducible proof-of-concept payloads or call sequences for every flagged vulnerability.
8. Verify database mutations are wrapped inside atomic transactions with rollbacks on failure.

## Pre-Flight Verification Runbook

Before beginning the adversarial audit:

1. **Extract Changed Files and Git Diffs**:
   ```bash
   git diff --name-only origin/main...HEAD
   git diff origin/main...HEAD
   ```
2. **Scan for New or Modified Third-Party Dependencies**:
   ```bash
   git diff origin/main...HEAD -- package.json pnpm-lock.yaml Cargo.toml
   ```
3. **Check for Security Advisories**:
   - Query npm audit or vulnerability registries for any newly introduced packages.

## The 5 Critical Attack Vectors

| Attack Vector | What to Look For | Real-World Impact |
|---|---|---|
| **1. Broken Object-Level Authorization (IDOR)** | Fetching records by ID (`/api/items/:id`) without validating tenant / user ownership | Data leakage across tenant boundaries |
| **2. Race Conditions & Concurrency Gaps** | Read-modify-write patterns without database-level row locks or atomic increments | Account double-spending, inventory overselling |
| **3. Idempotency Gaps** | Webhooks (e.g. Stripe, billing) that process charges without unique event ID deduplication | Duplicate charges, duplicated user credits |
| **4. Partial Failure & Missing Rollbacks** | Mutating DB table A, calling external service B, then updating table C without a transaction | Inconsistent system state and silent data corruption |
| **5. Resource Exhaustion / Unbounded I/O** | Missing `LIMIT` on queries, unescaped Regex on user strings (ReDoS), unbounded file uploads | Server CPU freeze, memory crash, denial of service |

## Patterns

### 1. Adversarial Audit Finding Template

```text
### [CRITICAL] Race Condition in Quota Deduction
- **File**: src/billing/quota.ts:45-62
- **Attack Vector**: Concurrent HTTP requests bypass usage limits
- **Proof of Concept**:
  Sending 10 concurrent requests when `remainingCredits = 1`:
  1. Request A reads remainingCredits = 1
  2. Request B reads remainingCredits = 1
  3. Request A executes operation and sets remainingCredits = 0
  4. Request B executes operation and sets remainingCredits = 0
  Result: User executes 2 operations while only paying for 1.
- **Remediation**:
  Replace application-level check with an atomic database query:
  `UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits >= 1 RETURNING credits;`
```

### 2. Idempotency & Webhook Double-Spend Vulnerability

```typescript
// ❌ VULNERABLE: Stripe webhook without idempotency or atomic transactions
export async function handleInvoicePaid(event: StripeEvent) {
  const invoice = event.data.object;
  const user = await db.query.users.findFirst({ where: eq(users.customerId, invoice.customer) });
  
  // Vulnerability: If Stripe sends duplicate webhooks, credits are added twice!
  await db.update(users).set({ credits: user.credits + 100 }).where(eq(users.id, user.id));
}

// ✅ SECURE & RESILIENT: Idempotency table + atomic transaction
export async function handleInvoicePaidSecure(event: StripeEvent) {
  const invoice = event.data.object;
  
  await db.transaction(async (tx) => {
    // 1. Guard against duplicate webhook deliveries
    const processed = await tx.insert(processedEvents).values({ id: event.id }).onConflictDoNothing();
    if (!processed.rowCount) return; // Already handled, exit safely

    // 2. Atomic credit increment
    await tx.update(users)
      .set({ credits: sql`credits + 100` })
      .where(eq(users.customerId, invoice.customer));
  });
}
```

## Anti-patterns

- **Auto-applying fixes without confirmation**: The reviewer's role is to stress-test and reveal failure modes, not to silently alter application code.
- **Reporting stylistic nits**: Commenting on indentation, variable naming, or comment phrasing dilutes focus from actual exploits and critical bugs.
- **Assuming input is sanitized**: Never assume client-provided IDs, numbers, or JSON payloads are validated upstream.
- **Assuming third-party SDK calls succeed**: External network requests can time out, return 500s, or drop connections midway through operations.

## Before returning

- [ ] Full diff analyzed against main branch
- [ ] Every finding cites exact file and line ranges
- [ ] Concrete failure triggers and real-world consequences detailed
- [ ] Explicit ship decision rendered (`BLOCKING_RISKS_DETECTED` or `APPROVE`)
- [ ] **Strict Stop Rule respected: No code edits executed without user confirmation**

## Review boundary and decision

Pin the exact change set and identify the implementation's actual trust/resource
boundaries. Review owned source and bounded defensive checks; do not construct
offensive workflows or contact live third-party targets. Every material finding
needs a reachable condition, impact and confidence level; missing evidence is
a validation gap. An approve verdict means no confirmed blockers in the examined
scope, not a proof that every failure mode is impossible. The stop rule remains:
return findings and wait for explicit confirmation before applying fixes.

## Skills in scope

- `security-scanner` — for running static AST checks and credential pattern scans
- `testing` — for writing regression tests proving discovered vulnerabilities
- `tech-stack` — for auditing supply chain packages and dependencies
