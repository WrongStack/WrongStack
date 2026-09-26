# Learned instructions for `security-scanner`

> Project-specific learning data for the `security-scanner` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-09-25T19:34:35.097Z; skill=api-design; skipped=1; skippedWins=1 -->
- **Always check `HqCommandAuditLog`'s ring orientation before flagging `seed()` ordering in `packages/core/src/hq/commands.ts` — the invariant is ascending (`record()` appends at the tail, `recent()` = `slice(-limit)` returns the newest window oldest→newest), and `unshift(...seeded)` of an append-ordered block preserves it; a "reverse before unshift" suggestion breaks the invariant, not fixes it. Never accept an eviction claim against the HQ WS supersede loop in `packages/cli/src/hq-server/ws.ts` without checking the `sameCredential` gate (~): only a matching credential can trigger `clients.delete` + `close(4001)` or inherit undelivered commands. The `readyState === OPEN` gate on the `4003` refusal is the deliberate rotated-token-reconnect design (documented at the comment above it), and `ws.on('close')` cleanup — not the TTL sweep — is the primary dead-holder removal path. ```json { "verification_evidence": { "typecheck": { "command": "pnpm exec tsc --noEmit -p packages/core", "exitCode": 0 } } } ```**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `HqCommandAuditLog`
  - *How:* `seed()`
  - *How:* `packages/core/src/hq/commands.ts`
  - *How:* `record()`
  - *How:* `recent()`
  - *How:* `slice(-limit)`
  - *How:* `unshift(...seeded)`
  - *How:* `packages/cli/src/hq-server/ws.ts`
  - *How:* `sameCredential`
  - *How:* `clients.delete`
  - *How:* `close(4001)`
  - *How:* `readyState === OPEN`
  - *How:* `4003`
  - *How:* `ws.on('close')`

<!-- learned-stamp: category=warning; capturedAt=2026-09-25T19:32:09.756Z; skipped=2; skippedWins=2 -->
- **In credential-expiry tests, never write a short-lived token fixture (e.g. `expiresAt = Date.now() + 1500`) before `await startHqServer()` or any slow async setup — startup latency can consume the validity window, so the expiry control under test rejects the first assertion instead of the intended one. Start the server first, then write the fixture, and size the pre-assertion window to exceed measured setup latency.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `expiresAt = Date.now() + 1500`
  - *How:* `await startHqServer()`

<!-- learned-stamp: category=warning; capturedAt=2026-09-25T20:09:35.565Z; skill=security-scanner -->
- **When an HQ credential change claims "the server is the authority", verify it by grepping the three server-side capability enforcement surfaces — `packages/cli/src/hq-server/routes/command-handlers.ts`, `routes/mailbox-handlers.ts`, and `mailbox-gateway-manager.ts` — before accepting the client-side comment; gating in `packages/webui-hq/src/domain/` is fail-open UX by design and is never an enforcement point. Always check `git status` for untracked new modules imported by tracked changed files before reporting an auth-path review as clean — a security enforcement module that exists only as an untracked file will vanish on a fresh clone even though the diff "looks complete" (`git diff HEAD` silently omits untracked files; the stat count will not match the file list).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/cli/src/hq-server/routes/command-handlers.ts`
  - *How:* `routes/mailbox-handlers.ts`
  - *How:* `mailbox-gateway-manager.ts`
  - *How:* `packages/webui-hq/src/domain/`
  - *How:* `git status`
  - *How:* `git diff HEAD`

<!-- learned-stamp: category=warning; capturedAt=2026-09-23T20:06:16.765Z; skill=security-scanner; skipped=3; skippedWins=3 -->
- **When reviewing a new `ToolCapabilities` constant, never trust the doc comment — verify the enforcement chain: (1) the tool actually declares the capability in `capabilities: [...]`, (2) `WIDE_SUBAGENT_CAPABILITIES` / `DANGEROUS_FOR_SUBAGENTS` membership in `packages/core/src/security/capabilities.ts`, (3) `AutoApprovePermissionPolicy.evaluate` in `packages/core/src/security/auto-approve-policy.ts`, which denies tools with no capability intersecting the subagent grant — `.some()` semantics mean a tool passes if ANY declared capability is allowed, so a single-purpose tool loses its restriction…**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `ToolCapabilities`
  - *How:* `capabilities: [...]`
  - *How:* `WIDE_SUBAGENT_CAPABILITIES`
  - *How:* `DANGEROUS_FOR_SUBAGENTS`
  - *How:* `packages/core/src/security/capabilities.ts`
  - *How:* `AutoApprovePermissionPolicy.evaluate`
  - *How:* `packages/core/src/security/auto-approve-policy.ts`
  - *How:* `.some()`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:32:09.756Z; skill=security-scanner; skipped=2; skippedWins=2 -->
- **When a security test fails only in a full-suite run but passes with a `-t` filter, suspect a setup-latency race, not a weakened check — verify with one scoped rerun before reporting a product regression.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `-t`

---
*Last capture: 2026-09-25T20:09:35.565Z · 5 entries*
