# Learned instructions for `audit-log`

> Project-specific learning data for the `audit-log` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-18T09:42:50.640Z; skill=bug-hunter; skipped=1; skippedWins=1 -->
- **When no process-execution tool is registered, replicate `.temp_files/core_fire_and_forget_scan/scan.mjs` semantics exactly via grep + reads — its CALLBACK regex is literal (`\.on\(` does NOT match `.onMessage(`, `.onClose(`, `createServer(`, `.addXxxListener(`) and its two-arg `.then` exclusion (scan.mjs:46) only recognizes arrow-function second args, so identifier handlers like `then(resolve, reject)` are flagged despite being contained. Reproduce both quirks or the hit set diverges from the scanner's.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `.temp_files/core_fire_and_forget_scan/scan.mjs`
  - *How:* `\.on\(`
  - *How:* `.onMessage(`
  - *How:* `.onClose(`
  - *How:* `createServer(`
  - *How:* `.addXxxListener(`
  - *How:* `.then`
  - *How:* `then(resolve, reject)`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-10-18T09:39:10.749Z; applied=1; wins=1; skipped=1; skippedWins=1 -->
- **Always enumerate every `void <call>(` line with grep before trusting `.temp_files/core_fire_and_forget_scan/scan.mjs` results — its CALLBACK regex only scans 6 lines ABOVE the void, so registrations that follow the call (`addEventListener` in `packages/tools/src/browser/manager-support.ts` abortable) and createServer-style handler shapes (`packages/tools/src/browser/network-guard-proxy.ts`) are invisible to it. Trace void'd callees across package boundaries (`packages/core/src/utils/heap-watchdog.ts`, `packages/persistence/src/project-endpoint.ts`) — rejection safety is decided in the callee, not the call site. Remember `.finally(` on a void'd promise does NOT handle rejection, and `try/finally` without `catch` (parser-worker-pool reparseInline pattern) still leaks rejections.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `void <call>(`
  - *How:* `.temp_files/core_fire_and_forget_scan/scan.mjs`
  - *How:* `addEventListener`
  - *How:* `packages/tools/src/browser/manager-support.ts`
  - *How:* `packages/tools/src/browser/network-guard-proxy.ts`
  - *How:* `packages/core/src/utils/heap-watchdog.ts`
  - *How:* `packages/persistence/src/project-endpoint.ts`
  - *How:* `.finally(`
  - *How:* `try/finally`
  - *How:* `catch`

<!-- learned-stamp: category=pattern; capturedAt=2026-11-05T19:47:33.275Z; skill=audit-log -->
- **Always verify a meta-tool's error contract against the executor's failure model (fail only when `execute` throws) before rating it — in this repo a returned `{ok:false}` result counts as success, so tools like `context_manager` that return "Unknown action" as a successful note silently hide invalid input, while `plan`/`task`/`kanban` correctly throw refusals after releasing file locks. Prefer `codebase-read-symbol` over whole-file reads for large tool files (plan.ts 547L, task.ts 678L, context-manager tool ~450L) — it returns line-numbered bodies within budget and avoids the read tool's deduped-range refusals on truncated outputs.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `execute`
  - *How:* `{ok:false}`
  - *How:* `context_manager`
  - *How:* `plan`
  - *How:* `task`
  - *How:* `kanban`
  - *How:* `codebase-read-symbol`

---
*Last capture: 2026-11-05T19:47:33.275Z · 3 entries*
