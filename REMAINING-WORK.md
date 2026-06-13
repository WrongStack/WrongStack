# Remaining Work — WrongStack

**Generated:** 2026-06-13
**Audit scope:** All open work items across security audits, refactor plans, bug reports, bench fixes, and mailbox coordination.

---

## Table of Contents

1. [P0 — Critical/Immediate Fixes](#p0--criticalimmediate-fixes)
2. [P1 — WebUI Server Refactor (PRs 5–8 of #30)](#p1--webui-server-refactor-prs-5-8-of-30)
3. [P2 — Frontend Security Follow-up (C-2)](#p2--frontend-security-follow-up-c-2)
4. [P3 — TUI Refactor — app.tsx Decomposition](#p3--tui-refactor--apptsx-decomposition)
5. [P4 — Capability-Based Authorization (Security Hardening P1)](#p4--capability-based-authorization-security-hardening-p1)
6. [P5 — Testing Gaps](#p5--testing-gaps)
7. [P6 — Documentation](#p6--documentation)
8. [P7 — Bench / Performance Tracking](#p7--bench--performance-tracking)
9. [Legend](#legend)

---

## P0 — Critical/Immediate Fixes

These are bugs found in automated audits that need fixing. They are small, surgical, and individually revertable.

| # | Issue | Severity | Found by | Status | Files |
|---|---|---|---|---|---|
| P0-1 | **Director listener leak** — `FleetBus.filter()` unsubs not captured, 2 dangling listeners per Director construction | Critical | Bug Hunter | ✅ Fixed (2026-06-13) | `packages/core/src/coordination/director.ts:638-641` |
| P0-2 | **WebUI shutdown abort** — shutdown() didn't abort in-flight provider runs (wasted spend on SIGINT/SIGTERM) | Critical | Bug Hunter | ✅ Fixed (2026-06-13) | `packages/cli/src/webui-server.ts:1284` |
| P0-3 | **Per-WS AbortController** — two browser tabs shared one abort controller; rapid same-tab abort raced | Critical | Bug Hunter | ✅ Fixed (2026-06-13) | `packages/cli/src/webui-server.ts:359,1329,2616,3071` |
| P0-4 | **`onBudgetWarning` typing** — function stored in state instead of being used as a callback | High | Bug Hunter | ✅ Fixed (see mailbox) | TUI state |
| P0-5 | **TODO/FIXME/Lint pass** — grep was non-functional during bug hunt, so the full TODO/FIXME sweep was incomplete | Medium | Bug Hunter | ✅ Fixed (2026-06-13) | Codebase clean — no TODO/FIXME/HACK/XXX/BUG found |

---

## P1 — WebUI Server Refactor (PRs 5–8 of #30)

Goal: split `packages/cli/src/webui-server.ts` (3,407 lines, 2nd largest file in the repo) into focused modules.

**Ref:** `docs/refactor-next.md`, `docs/issues/2026-06-13-webui-server-refactor.md`

### Completed

| PR | Module | Status | PR # |
|---|---|---|---|
| 0 | Baseline integration test | ✅ Merged | #53 |
| 1 | `logger-shim.ts` | ✅ Merged | #50 |
| 2 | `cost-helpers.ts` | ✅ Merged | #51 |
| 3 | `context-breakdown.ts` | ✅ Merged | #52 |
| 4 | `provider-config.ts` | ✅ Merged | #55 |
| 6 | `static-serve.ts` | ⚠️ Committed, PR not opened | `refactor/webui-server-static-serve` branch, commit `ab245dc4` |

### Remaining

| # | Module | Risk | Effort | Dependencies |
|---|---|---|---|---|
| **P1-1** | **PR 5 — `ws-handlers/` directory** | **HIGH** | 2-3 days | None (all preceding PRs merged) |
| **P1-2** | **PR 6 — Open PR for `static-serve.ts`** | Low | 30 min | Unit tests for `startStaticServe` |
| **P1-3** | **PR 7 — `lifecycle.ts`** | Low | 1-2 h | PR 6 merge (httpServer type change) |
| **P1-4** | **PR 8 — Final pass** | Low | 1 h | All PRs 1-7 complete |
| **P1-5** | **Follow-up: `ProviderConfigStore` facade** | Medium | 2-4 h | PR 4 merged (dedup two import paths) |

### PR 5 — ws-handlers/ extraction (HIGH PRIORITY)

The 25+ inline `handleXxx` WebSocket handlers move into topic-split files:

```
webui-server/ws-handlers/
  providers.ts   — handleProviderAdd, handleProviderKeyAdd, … (~400 lines)
  sessions.ts    — handleSessionList, handleSessionGet, …      (~300 lines)
  mailbox.ts     — handleMailboxSend, handleMailboxRead, …     (~200 lines)
  worktree.ts    — handleWorktreeList, handleWorktreeCreate, … (~200 lines)
  memory.ts      — handleMemoryList, handleMemoryRemember, …   (~200 lines)
  index.ts       — barrel: registerAllHandlers(wsServer, ctx)  (~50 lines)
```

**Key design decision:** Create a `WsHandlerContext` interface to thread shared state (providers, vault, wpaths, eventBridge, broadcast) explicitly — no closure captures allowed. Each file exports a `register*` function. `webui-server.ts` calls `registerAllHandlers(wss, ctx)` after PR 8.

**Risk:** HIGH. Handlers share closure-captured mutable state today. Every single handler must be reviewed for undrawn closure references.

---

## P2 — Frontend Security Follow-up (C-2)

C-2 (WebSocket token in URL) was fixed server-side. The frontend needs a follow-up.

| # | Task | Severity | Status | Files |
|---|---|---|---|---|
| **P2-1** | **Remove `wsToken` from `session.start` payload** — token is sent via cookie, no longer needs to be in response body | High | ✅ Fixed (2026-06-13) | `packages/webui/src/server/index.ts` (already lacks wsToken), `packages/webui/tests/server/session-payload.test.ts` updated |
| **P2-2** | **Verify `ensureAuthCookie()` on client** — the WebSocket reconnection path must set the cookie before the WS upgrade | Medium | ✅ Fixed | `packages/webui/src/lib/ws-client.ts` |
| **P2-3** | **Regression test for C-2** — automated test proving token is not in URL or sessionStorage | Medium | ✅ Fixed (2026-06-13) | `packages/webui/tests/server/session-payload.test.ts` — `wsToken` removed from required fields, added `does NOT include wsToken` test |

---

## P3 — TUI Refactor — app.tsx Decomposition

**File:** `packages/tui/src/app.tsx` — 5,671 lines, largest file in the repo.

**Ref:** `docs/issues/2026-06-13-tui-app-refactor.md`

**Status:** ⚠️ **DEFERRED** (high risk, zero test coverage)

The session-long audit (2026-06-13) concluded: do NOT refactor app.tsx without first establishing a baseline integration test. The file has:
- 7+ inline hooks (useState, useEffect, useRef)
- ~15 inline handler functions
- WebSocket client lifecycle interleaved with React rendering
- No tests whatsoever

### Recommended approach (deferred to separate PRs)

| # | Step | Risk | Prerequisite |
|---|---|---|---|
| **P3-1** | Baseline integration test (e.g., mount with mock WS, verify messages render) | Medium | Jest/Testing Library setup for TUI |
| **P3-2** | Extract `useWebSocket` hook | Medium | P3-1 |
| **P3-3** | Extract `useSessionList` / `useSessionDetail` / `useProviderConfig` hooks | Low | P3-2 |
| **P3-4** | Extract sidebar panel component | Low | P3-3 |
| **P3-5** | Extract message list + message input components | Low | P3-4 |

**Do not start P3-5 without P3-1.** The baseline test alone is worth doing first as a separate small PR.

---

## P4 — Capability-Based Authorization (Security Hardening P1)

**Ref:** `docs/plans/security-hardening-2026-06.md`

### Phase 1.1 — Tool Capability Tags

| # | Task | Effort | Status |
|---|---|---|---|
| **P4-1** | Add optional `capabilities?: string[]` to `Tool` interface | 1 h | ✅ Already exists (2026-06-13) | `packages/core/src/types/tool.ts:116` |
| **P4-2** | Define canonical capability names: `fs.write`, `shell.arbitrary`, `net.outbound`, `mcp.proxy`, `subagent.spawn`, `tool.mutate.any` | 30 min | ✅ Fixed (2026-06-13) | Used: `fs.read`, `fs.write`, `shell.restricted`, `memory.read`, `memory.write`, `memory.delete`, `session.todo`, `session.mode`, `tool.meta`, `tool.mutate.any` |
| **P4-3** | Update `AutoApprovePermissionPolicy` to use capabilities as primary check | 2-3 h | 🔴 **Open** | Blocked on P4-5 |
| **P4-4** | Update subagent dangerous-tool guard to allowlist by default | 1-2 h | 🔴 **Open** | Blocked on P4-5 |
| **P4-5** | Add capability declarations to all built-in tools (read, edit, write, bash, glob, grep, fetch, todo, memory) | 2 h | ✅ Fixed (2026-06-13) | 15 tools updated, commit `0ee9ac14` |

### Phase 1.2 — Plugin Mutation Rules

| # | Task | Effort | Status |
|---|---|---|---|
| **P4-6** | Add `capabilities` requirement for plugins mutating tools they don't own | 1-2 h | 🔴 **Open** |

### Phase 1.3 — Documentation & Migration

| # | Task | Effort | Status |
|---|---|---|---|
| **P4-7** | Document capability model in `docs/tool-author-guide.md` | 1 h | 🔴 **Open** |
| **P4-8** | Update `SECURITY.md` with capability model | 30 min | 🔴 **Open** |

---

## P5 — Testing Gaps

| # | Gap | Affected code | Effort | Status |
|---|---|---|---|---|
| **P5-1** | `startStaticServe` has no unit tests | `packages/cli/src/webui-server/static-serve.ts` | 2-3 h | ✅ Already exists (2026-06-13) | `packages/cli/tests/webui-server/static-serve.test.ts` has comprehensive tests |
| **P5-2** | TUI app.tsx has zero test coverage | `packages/tui/src/app.tsx` | 4-6 h (baseline) | ⚠️ Deferred (P3) |
| **P5-3** | E2E test for WebUI — no `--webui` mode integration test | CLI entry | 4-6 h | ⚠️ Deferred (large task, needs separate PR) |
| **P5-4** | Baseline integration test for Director shutdown (listener leak) | `packages/core/src/coordination/director.ts` | ✅ Fixed | See `director.test.ts` |
| **P5-5** | Regression test for C-2 frontend fix | `packages/webui/tests/` | 2-4 h | ✅ Fixed (2026-06-13) | `packages/webui/tests/server/session-payload.test.ts` |

---

## P6 — Documentation

| # | Doc | Effort | Status |
|---|---|---|---|
| **P6-1** | Tool author guide — add capability model docs | 1 h | 🟡 In progress (P4-1~P4-5 done, docs pending) | `docs/tool-author-guide.md` |
| **P6-2** | Update SECURITY.md with capability model | 30 min | 🟡 In progress (P4-1~P4-5 done, docs pending) | `SECURITY.md` |
| **P6-3** | Clean up orphan docs (7 deleted per mailbox status) | 30 min | ✅ Done |

---

## P7 — Bench / Performance Tracking

| # | Item | Status | Notes |
|---|---|---|---|
| **P7-1** | M3 bench fix — apples-to-oranges comparison corrected | ✅ Fixed (commit `83de1ca9`) | Now uses preFixScan() for honest 4KB full-scan vs 4KB tail-scan |
| **P7-2** | M1 bench annotated — noise-band note added | ✅ Fixed (commit `83de1ca9`) | 0.87-1.31× range across 5×2000 iterations, all distributions cross 1.0× |
| **P7-3** | Run fixed bench to verify | 🔴 **Open** | Needs `/kill reset` then `node scripts/bench.mjs` |
| **P7-4** | Remove stale probe files | ✅ Fixed (2026-06-13) | `bench-m1.log` deleted; m1-*, m3-* files already gone |

### M-tier audit key finding (2026-06-13)

| Fix | Bench shows | Reality | Verdict |
|---|---|---|---|
| H3 (compact early-exit) | 6-9× speedup | Real, clean, measurable | ✅ Honest |
| M1 (combined pass) | 0.89-1.04×, noisy | Below noise floor (0.87-1.31× range) | ⚠️ Now labelled |
| M3 (tail scan) | 1.5-2.0× "clean" | Apples-to-oranges; real win ~0.3 µs | 🔧 Fixed |
| H5 (LRU) | Removed | Correct call, 0% production hit rate | ✅ Already handled |

---

## Legend

| Marker | Meaning |
|---|---|
| 🔴 **Open** | Not started |
| 🟡 In progress | Being worked on |
| ⚠️ Deferred | Deliberately postponed (with reason) |
| ✅ Fixed/Complete | Done, verified |
| (blocked on X) | Cannot start until X finishes |

---

**END OF REMAINING-WORK.md**
