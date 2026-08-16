# RAM Memory Leak Audit — WrongStack

**Date:** 2026-08-16
**Scope:** Static analysis of `packages/` and `apps/desktop` — full-system sweep for unbounded RAM retention (timers, listeners, caches, watchers, workers, process handlers, module-level collections), followed by remediation of actionable findings and regression-test coverage.
**Method:** Symbol-index search + pattern greps; every candidate read at source level before classification. Cross-checked against prior audit memory and re-verified against current disk state. No runtime instrumentation (no heap snapshots).
**Line references reflect the working tree at audit close (2026-08-16).**

---

## Executive Summary

The sweep classified **3 LOW findings** — all bounded retention, none unbounded. Two were remediated this session with in-repo patterns; one was retired as a **false positive** (the audit's own verification gap, documented below). Re-verification of every HIGH/MEDIUM claim from prior audits (2026-07-29, 2026-08-11) confirmed **all are fixed on disk**.

| # | Severity | Location | Status |
|---|---|---|---|
| 1 | LOW | `packages/cli/src/auth-menu/github-copilot-oauth.ts` — `sleep()` abort-listener accumulation | **Fixed** (token-throttle pattern) |
| 2 | LOW | `packages/core/src/storage/session-store.ts` — `clearHistory()` cache invalidation | **False positive** (already invalidated; alias-key hardening confirmed on disk) |
| 3 | LOW | `packages/webui/src/lib/ws-client.ts` — `suppressedChatEchoes` TTL asymmetry | **Fixed** (lazy periodic sweep) |

**No HIGH or MEDIUM findings remain open.**

---

## Finding 1 — LOW — copilot `sleep()` abort-listener accumulation — FIXED

**Defect:** The local `sleep(ms, signal)` helper registered `signal.addEventListener('abort', …, { once: true })` with no removal on the timeout path. The device-flow poll loop (`while (Date.now() < expiresAt) { await sleep(intervalMs, signal) … }`) reuses **one** `AbortSignal` across iterations, so each completed poll left one listener-closure attached until the flow-scoped controller was GC'd.

**Fix (in-repo pattern: `packages/plugins/src/token-throttle/index.ts:176-193`):** named `onAbort` handler detached via `signal.removeEventListener('abort', onAbort)` inside the `setTimeout` callback. Applied at `github-copilot-oauth.ts:52-69`.

**Regression coverage:** two tests in `packages/cli/tests/github-copilot-oauth.test.ts` — one instance-spy variant (fake timers, 3 iterations, asserts `abortAdds === abortRemoves === 3`), one `EventTarget.prototype`-spy variant (real timers, 4 iterations, asserts add/remove symmetry and identity of detached handlers).

## Finding 2 — LOW — `clearHistory()` cache invalidation — FALSE POSITIVE (corrected)

**Original claim:** `clearHistory()` did not invalidate `SessionLoadCache`, retaining a full `SessionData` graph after `/clear`.

**Verification:** false. `clearHistory()` already ends with `this.clearLoadCache(canonical)` plus an alias guard `if (id !== canonical) this.clearLoadCache(id)` (`packages/core/src/storage/session-store.ts:805-809`), because `loadInternal()` caches under the **raw** id it was called with while `canonical` resolves catalog aliases. The cache is additionally hard-bounded (`LOAD_CACHE_MAX_ENTRIES = 50`, `LOAD_CACHE_MAX_BYTES = 64 MiB`, `load-cache.ts:4-5`) and self-heals via mtime/size mismatch on the next read (`load-cache.ts:39`).

**Root cause of the false call:** the verification grep pattern `loadCache\.(clear|delete)` cannot lexically match the method name `clearLoadCache(`. Lesson recorded: derive audit greps from the API surface (method names), not assumed internals, and read the full function body before recording a finding.

## Finding 3 — LOW — `suppressedChatEchoes` TTL asymmetry — FIXED

**Defect:** per-type suppression arrays (`CHAT_ECHO_RESPONSE_BY_REQUEST`) capped at `MAX_PER_TYPE = 32` on push, but TTL trimming ran only in `consumeSuppressedChatEcho()` — a response type suppressed but never consumed (chat view unmounted, user elsewhere) retained 32 stale timestamps per type indefinitely (~6.5 KB worst case).

**Fix:** lazy `echoSweepTimer` (`CHAT_ECHO_SUPPRESSION_SWEEP_MS = 15_000`) armed on first suppression, shared across pushes, self-stopped when the map empties, and torn down in `disconnect()` alongside `suppressedChatEchoes.clear()`. Applied at `ws-client.ts:90-97, 163, 659, 727-755, 975-981`. Retention is now bounded by TTL + one sweep interval; no timer exists for clients that never suppress.

**Regression coverage:** two tests in `packages/webui/tests/lib/ws-client-chat-echo.test.ts` — one observing the timer lifecycle via `vi.getTimerCount()` (arm → clear → self-stop; disconnect teardown), one casting to internals to assert arming, timer sharing across pushes, no-op sweep before TTL, expiry without consume, self-stop, lazy re-arm.

---

## Prior-audit claims re-verified FIXED on disk (this session)

| Prior claim | Current state (verified lines) |
|---|---|
| Kanban event-emitter unbounded listener Set | `MAX_LISTENERS = 200`, logged rejection + no-op disposer (`packages/kanban/src/server/event-emitter.ts:30, 60-71`) |
| EventBus uncapped named listeners | `MAX_NAMED_LISTENERS = 2000` / `MAX_WILDCARDS = 500` on every register path (`packages/core/src/kernel/events.ts:33, 129, 192, 220, 451, 477, 498`) |
| FleetManager `removeSubagent()` meta/priceLookup retention | full cleanup incl. correctly-keyed `priceLookups` (`packages/core/src/coordination/fleet-manager.ts:718-747`) |
| `agent-bridge.ts` persistent `ws.on('message')` | named handler + `ws.off` in close/reconnect + generation guard (`apps/desktop/src/main/agent-bridge.ts:174-187, 223-236, 380-386`) |
| OAuth sibling cleanup (deferred 2026-08-11) | **closed** — `anthropic`, `openai-codex`, `github-copilot` all detach `onExternalAbort` in `finally` |
| `pendingConfirms` no TTL | `sweepExpiredPendingConfirms()` on insert + disconnect (`ws-client.ts:530, 579-583`) |
| `terminal-server.ts` abort listener | idempotent `dispose()` + `[Symbol.dispose]` |
| `BrainDecisionCache` index leak | `removeEntry()` cleans `keyByRequestId`; 500-id cap; `maxEntries = 200` |

Also verified clean this session: process-guardian handler symmetry, heap-watchdog (incl. shared contributor map), MCP client abort guards + pending-request rejection on child exit, analytics ring buffer (1000 events + synced counters), collaboration/goal WS handlers (`offs` cleanup, bucket deletion, `dispose()`), SSE per-connection teardown, worker pools (`terminate()` on all paths incl. error paths), kanban server client heartbeat/listener teardown, `useChatViewState` (7/7 symmetric listener pairs), module-level Map/Set/arrays (all static allow-lists or bounded).

**Stale memory corrected:** recall claimed the Kanban emitter was still uncapped — false on disk; superseding memory written. The long-standing `pendingConfirms`-no-TTL memory is likewise stale (fix verified at `ws-client.ts:530, 579-583`).

---

## Verification evidence (this session)

- `tsc --noEmit`: **0 errors** in `packages/cli`, `packages/webui`, `packages/core`.
- `biome format` + organize-imports: **clean**, 0 changes.
- Targeted vitest:
  - `packages/cli` `tests/github-copilot-oauth.test.ts`: **17/17 passed** (incl. 2 new regression tests).
  - `packages/webui` `tests/lib/ws-client-chat-echo.test.ts`: **7/7 passed** (incl. 2 new regression tests).
  - `packages/core` `tests/storage/session-store.test.ts`: **12/12 passed**.
- Chimera post-session review of the new tests: **0 findings**.

## Files changed (working tree)

| File | Change |
|---|---|
| `packages/cli/src/auth-menu/github-copilot-oauth.ts` | Fix 1 — abort-listener detach in `sleep()` |
| `packages/webui/src/lib/ws-client.ts` | Fix 3 — lazy echo-sweep timer + disconnect teardown |
| `packages/core/src/storage/session-store.ts` | (no functional change needed; alias-key invalidation already present at `:805-809`) |
| `packages/cli/tests/github-copilot-oauth.test.ts` | +2 regression tests |
| `packages/webui/tests/lib/ws-client-chat-echo.test.ts` | +2 regression tests |

## Out-of-scope observations (deferred, no action taken)

- `delete()` and `rename()` in `session-store.ts` (`:747`, `:761`) invalidate only the canonical id — the same alias-key shape `clearHistory` guards against. Both paths are bounded by the same 50-entry/64 MiB cache caps and the mtime/size self-heal, so no leak; hardening them would be consistency-only.
- The two parallel regression-test variants (instance-spy vs prototype-spy; timer-count vs internals-cast) were deliberately kept — they observe the same contract through different seams.

## Watchlist (patterns not currently leaking)

`ws.on(...)` vs `ws.once(...)` in new transport code; `process.on('SIGINT')` in CLI flows (all current ones detach in `finally`); long-lived `FSWatcher`s without `close()`; `Worker` threads without error-path `terminate()`; promise chains retained per queued write (the heap-watchdog's `pendingLine` pattern is the reference fix).
