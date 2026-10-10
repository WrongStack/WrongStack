---
name: code-review
description: |
  Use this skill when asked to review code changes — a pull request, a branch, a commit range, or the current diff — for correctness, security, and maintainability before they merge.
  Triggers: user says "review", "code review", "review this PR", "review my changes", "look over the diff", "is this ready to merge", "PR feedback", "anything wrong with this change".
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [version-control.manage, code.inspect, verification.run]
trigger: "Use this skill when asked to review code changes \u2014 a pull request, a branch, a commit range, or the current diff \u2014 for correctness, security, and maintainability before they merge."
metadata:
  routing-group: quality
---

# Code Review

## Selection card
- Task: Review implementation correctness and maintainability.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

A review finds what the author can't see from inside the change: inputs they
didn't consider, callers the change breaks, security holes, and design that will
be expensive to live with. It is read-only unless the user asks for fixes.

This is the on-demand review of any change set. `chimera` is the automatic
review of files changed during a WrongStack session.

## Rules

1. Pin the change set exactly — `git diff <base>...HEAD` for a branch, the PR
   diff, or staged plus unstaged changes locally — and state the base you
   reviewed against.
2. Learn the intent first: PR description, linked issue, commit messages. Judge
   the change against what it is meant to do.
3. Read changed code in context — the whole function, its callers, and its
   tests — not only the diff hunks.
4. Check the blast radius. For every changed signature, return shape, thrown
   error, default value, or config key, find the callers (the
   codebase-impact-analysis or codebase-incoming-calls tool when the index
   exists, grep otherwise) and confirm they still work.
5. Every finding cites `file:line`, names the input or scenario that breaks and
   the consequence, and proposes a concrete fix. Without a scenario it is a
   question, and should be asked as one.
6. Rank by severity — blocking, should fix, nit — and keep nits few so they
   never bury a blocker.
7. Skip what the formatter and linter already enforce.
8. Say what you verified and what you did not.
9. Stay read-only unless the user asks for fixes.

## What to check, in priority order

1. **Correctness** — conditions and boundaries, null, empty and very large
   inputs, error paths, awaited async work and ordering, concurrency, resource
   cleanup, behaviour on retry.
2. **Contracts** — public API, schema, and config changes; migrations and their
   rollback; callers updated; backwards compatibility.
3. **Security** — validation at trust boundaries, object-level authorization,
   injection (SQL, shell, HTML, paths), secrets, SSRF, sensitive data in logs.
4. **Tests** — something fails without this change; edge and error cases
   covered; assertions on behaviour.
5. **Operability** — errors carry context, logs or metrics where diagnosis will
   need them, timeouts on I/O, a way to turn risky behaviour off.
6. **Maintainability** — an existing helper duplicated (search before accepting
   a new one), naming, dead code, comments that explain why.
7. **Performance** on hot paths — N+1 queries, unbounded loads, blocking I/O on
   request paths.

## Workflow

1. **Scope** the change set and the base.
2. **Intent** from the description, issue, and commits.
3. **Map** the diff: list files, group them by concern, and skim everything once
   before commenting.
4. **Deep read** in the priority order above, with blast-radius checks.
5. **Run what is cheap and allowed** — type check, lint, and the covering tests
   (the codebase-targeted-test tool finds them).
6. **Write** the review.

## Output

```text
## Review — feature/retry-charges against main

**Verdict:** Request changes
Adds automatic retries to card charges; the retry path can double-charge.

### Blocking
1. src/billing/charge.ts:88 — each retry sends a new charge without an idempotency
   key, so a timeout after the provider accepted the first attempt charges twice.
   → Send `idempotencyKey: order.id` on every attempt.

### Should fix
2. src/api/orders.ts:41 — `limit` is not capped; `?limit=100000` loads the whole table.
   → Clamp it to 100.

### Nits
3. src/billing/charge.ts:12 — rename `tmp` to `pendingCharge`.

### Verified
Type check and the billing tests pass. End-to-end suite not run.
```

When nothing blocks, say so plainly. A short approval is a complete review.

## Anti-patterns

- **Reviewing only the hunks** without the surrounding code and callers.
- **Style-only reviews** that miss the bug.
- **Vague comments** — "this looks off", "consider refactoring".
- **Speculation stated as fact.**
- **Redesigning the change** to personal preference.
- **Approving without reading the tests.**

## Before returning

- [ ] Change set and base stated; intent understood
- [ ] Changed code read in context; callers of changed contracts checked
- [ ] Every finding has `file:line`, a breaking scenario, and a fix
- [ ] Severity ranked; nits few and labelled
- [ ] What was and wasn't verified is stated
- [ ] No files modified unless fixes were requested

## Evidence identity

Read both tracked changes and relevant untracked additions for a local review;
git diff alone omits untracked files. Pin the reviewed head/base and preserve
pre-existing edits. Use merge-base semantics for branch intent and exact-head
CI for release decisions. A green check for an older revision cannot approve
the current diff. Separate source-supported concerns from tested failures.

## Skills in scope

- `security-scanner` — for a deeper pass on security-sensitive changes
- `bug-hunter` — for scanning beyond the diff when a defect pattern repeats
- `testing` — for judging whether the tests prove the change
- `chimera` — for the automatic post-session review format
