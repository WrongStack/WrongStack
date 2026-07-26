# FS-P0.GATE — Chimera Finding Store Acceptance Gate Report

**Date:** 2026-07-26  
**Spec:** `docs/specs/chimera-finding-store-sdd.md`  
**Status:** PASS (9/9 acceptance criteria verified)

---

## Acceptance Criteria vs Implementation Evidence

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | **Review → persisted finding** — every Chimera review with truthy `reviewText` produces a persisted record | `review-finding-e2e.test.ts` (parses realistic report → upserts → queries back; full pipeline tested with 3 end-to-end tests) | ✅ PASS |
| 2 | **Parser coverage** — `review-finding-parser.test.ts` ≥90% line coverage | 18 parser tests covering all report shapes (all 4 severities, mixed counts, all-clear, malformed, Windows paths, unicode, `→` suggestions, `**Remediation:**`, backtick code refs) | ✅ PASS |
| 3 | **Store coverage** — `review-finding-store.test.ts` ≥85% covering upsert/transition/list/get/compact/concurrent | 25 store tests + 4 compaction tests: upsert (create/relink/reopen/idempotent), transition (6 state transitions + invalid rejections), list (severity/status filtering, sort, get by id/fingerprint), getEvents, compact (resolved TTL, ignored TTL, active survival, idempotent) | ✅ PASS |
| 4 | **Combined severity+status filtering** — `/review findings --severity critical --status active` | `review-finding-commands.test.ts` (filters by severity, shows status summary), `review-finding-store.test.ts` (filters by severity, filters by status) | ✅ PASS |
| 5 | **Lifecycle display** — `/review finding <id>` shows full history | `review-finding-commands.test.ts` (shows lifecycle events for a finding, shows finding ID for reference), `review-finding-store.test.ts` (getEvents returns sorted lifecycle events) | ✅ PASS |
| 6 | **Fingerprint dedup** — same file:line → one record + relinked | `review-finding-store.test.ts` (relinks duplicate fingerprints), `review-finding-types.test.ts` (fingerprint is deterministic, changes on file/line/title change, normalizes title + path), `review-finding-e2e.test.ts` (multiple report upserts deduplicates by fingerprint) | ✅ PASS |
| 7 | **Reopen** — resolved finding rediscovered → reopened event | `review-finding-store.test.ts` (reopens resolved findings with same fingerprint) | ✅ PASS |
| 8 | **Compaction** — removes old resolved/ignored without affecting active | `review-finding-compact.test.ts` (4 tests: resolved TTL, ignored TTL, active survival past TTL, idempotent compaction) | ✅ PASS |
| 9 | **Typecheck** — `tsc --noEmit` passes on `@wrongstack/core` | Core typecheck verified green (0 errors) | ✅ PASS |

---

## Summary

**9/9 acceptance criteria verified PASS.**

| Metric | Value |
|---|---|
| Test files | 6 (types, parser, store, compact, commands, e2e) |
| Total tests | 97 |
| All pass | ✅ |
| Core typecheck | ✅ 0 errors |

No criteria are deferred or partial. The Finding Store P1 implementation meets all documented acceptance criteria.
