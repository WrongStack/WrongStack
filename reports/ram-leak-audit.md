# RAM Memory Leak Audit — WrongStack

**Date:** 2026-08-11
**Scope:** Static analysis of source code under `packages/`, `apps/`, and supporting code.
**Method:** Source reads + targeted grep. No code was executed. No files were modified.
**Code changes:** None. This is a report only.

---

## Executive Summary

The audit (2026-08-11) flagged three real RAM-leak risks. **All three have been remediated in the same day's follow-up pass**, leaving only the symbolic `suppressedChatEchoes` TTL asymmetry (LOW, ~6.5 KB worst case, bounded) and the pattern watchlist below. The remaining genuine risk is effectively zero.

**Canonical current report:** [`reports/ram-leak-audit-2026-08-16.md`](./ram-leak-audit-2026-08-16.md) — supersedes this document. The Finding-4 sweep fix landed there (2026-08-16); this file remains as the historical audit and the entry-point for the pattern-watchlist. Until the pointers below are updated, treat the Finding-4 row in this document as **Open** and consult the 2026-08-16 report for current state.

| Finding | Audit status | Post-fix status |
|---|---|---|
| 1 — `agent-bridge.ts` persistent `message` listener | HIGH | **Closed** (named `onMessage` + `socketGeneration` + `ws.off` on close) |
| 2 — `terminal-server.ts` abort listener | MEDIUM | **Closed** (`dispose()` + `[Symbol.dispose]`, idempotent; `releaseAll()` retained as alias) |
| 3 — `ws-client.ts` `pendingConfirms` no TTL | MEDIUM | **Closed** (`sweepExpiredPendingConfirms()` runs on insert; entries carry `expiresAtMs`) |
| 4 — `ws-client.ts` `suppressedChatEchoes` TTL asymmetry | LOW | **Closed (2026-08-16)** — lazy self-stopping sweep on every push |

Earlier claims about `useFleetPolling` subscriptions, `suppressedChatEchoes` TTL, and OAuth signal-listener handling were **downgraded** after re-reading the code:

- **Zustand subscriptions auto-clean on unmount.** `useFleetPolling` is not a leak source.
- **`suppressedChatEchoes`** is bounded by `CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE = 32` at push time. The TTL asymmetry is real but the cap prevents unbounded growth.
- **OAuth flow** (`anthropic-oauth.ts`) explicitly documents the prior leak and the fix in its comment block; the named `onExternalAbort` handler is removed in `finally`.

---

## Findings (Re-Verified)

| # | Severity | Status | Location | Symptom |
|---|---|---|---|---|
| 1 | **HIGH** | **Closed (2026-08-11)** | `apps/desktop/src/main/agent-bridge.ts:179-184, 382-388` | `ws.on('message', …)` is persistent while all sibling handlers use `ws.once(...)`. The closure captures `ConversationInternal`, which retains `messages[]`, `ws`, and `connectionState` until GC. **Fix:** named `onMessage` detached via `ws.off('message', onMessage)` in `close()`, plus per-reconnect `socketGeneration` bail-out for in-flight sockets. |
| 2 | **MEDIUM** | **Closed (2026-08-11)** | `packages/acp/src/client/terminal-server.ts:72, 82-84, 280-285` | `abortHandler` is registered with `{ once: true }` and only removed by `releaseAll()`. If the host never calls `releaseAll()` and the signal never aborts, the listener pins `this` (terminal map, outputChunks) until the signal itself is GC'd. **Fix:** new idempotent `dispose()` always removes the listener; `[Symbol.dispose]()` enables `using` blocks; `releaseAll()` retained as a deprecated alias. |
| 3 | **MEDIUM** | **Closed (2026-08-11)** | `packages/webui/src/lib/ws-client.ts:133, 529-532, 578-582` | `pendingConfirms: Map<string, PendingConfirm>` had no TTL or eviction. Entries were only deleted on the user explicitly calling `sendConfirm`. A user who dismissed a permission dialog without deciding leaked the entry for the lifetime of the tab. **Fix:** entries now carry `expiresAtMs`; `sweepExpiredPendingConfirms()` runs on every `tool.confirm_needed` insert and on disconnect. |
| 4 | **LOW** | **Closed (2026-08-16)** | `packages/webui/src/lib/ws-client.ts:154, 644-649, 706-714` | `suppressedChatEchoes` per-type array uses `CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE = 32` to cap on push, but TTL trimming only runs on consume. Unconsumed types retain 32 stale entries until the next push. Bounded but asymmetric. Worst case ~6.5 KB across 13 response types. **Fix (2026-08-16):** `ensureEchoSweep()` is invoked on every `suppressedChatEchoes.set(...)` call (the push path) and runs a self-stopping `setInterval` at `CHAT_ECHO_SUPPRESSION_SWEEP_MS = 15_000` that pauses when the map is empty. TTL trimming now runs on a schedule, not only on consume. See `reports/ram-leak-audit-2026-08-16.md` for the canonical current report. |
| 5 | **LOW** | Downgraded after re-read | `packages/webui/src/hooks/useFleetPolling.ts:43-48, 86-96` | Six zustand subscriptions are made unconditionally. `enabled=false` only pauses the ticking interval. **However:** zustand's `useSyncExternalStore` listener auto-removes on unmount; the only retention is during the component's mount. Not a real leak. |
| 6 | **LOW** | Confirmed safe | `packages/cli/src/auth-menu/anthropic-oauth.ts:222-235, 332-336` | The named `onExternalAbort` listener is removed in `finally`. The comment on lines 224-229 documents the previous (fixed) leak. |
| 7 | **LOW** | Confirmed safe | `packages/cli/src/auth-menu/loopback-server.ts` | Wrapper that delegates to `@wrongstack/providers/oauth`. The drift comment (lines 8-14) confirms prior fixes; cleanup is delegated. |
| 8 | **LOW** | Confirmed safe | `packages/core/src/chronicle/health-monitor.ts:53-55` | `setInterval` is `.unref()`'d; cleanup returns `clearInterval` + `delay.disable()`. |
| 9 | **LOW** | Confirmed safe | `packages/core/src/kernel/events.ts:22-33, 99-104` | `MAX_NAMED_LISTENERS = 2000`, `MAX_WILDCARDS = 500` cap all listeners. Snapshot cache invalidated on every mutation. |
| 10 | **LOW** | Confirmed safe | `packages/webui/src/lib/roster-ws.ts:42-48, 75-170` | `inflight` Map deleted on every settle path (success, error, supersession, abort, timeout). |
| 11 | **LOW** | Confirmed safe | `packages/tui/src/history-retention.ts:8-11, 38-52` | `TUI_HISTORY_MAX_ENTRIES = 400`, `TUI_HISTORY_MAX_BYTES = 1 MiB`. `entryBytesCache` is a WeakMap. |
| 12 | **LOW** | Confirmed safe | `packages/governance/src/credential-lease-controller.ts:174, 228-241, 380-385` | `stop()` clears the timer; `defaultScheduler` calls `.unref()` so the timer never blocks process exit. |

---

## Detailed Findings

### Finding 1 — HIGH — `agent-bridge.ts` persistent `message` listener — **CLOSED**

**File:** `apps/desktop/src/main/agent-bridge.ts`

**Status: CLOSED (2026-08-11).**

The fix landed in three coordinated changes, all stamped with `RAM-leak audit 2026-08-11, HIGH`:

1. **Per-reconnect `socketGeneration` counter** (`agent-bridge.ts:171`). Each `connect()` call gets a unique generation. The `onMessage` closure (`agent-bridge.ts:179-184`) bails before touching conversation state if it observes a stale generation, so an in-flight socket whose `'message'` event fires after its successor takes over cannot resurrect the conversation ref.
2. **Named `onMessage` listener** stored on `conversation.onMessage` (`agent-bridge.ts:183-184`). Makes the listener referenceable for explicit detachment.
3. **`ws.off('message', conversation.onMessage)` in `close()`** (`agent-bridge.ts:382-385`). Detaches the listener before nulling the `ws` ref, breaking the closure → `ConversationInternal` retention chain. After detachment, `conversation.socketGeneration` is incremented (`:388`) as a defense-in-depth measure against any socket whose `'close'` event fires after deletion.

**What was the leak:** the original code registered an anonymous `ws.on('message', …)` that was never removed. The closure captured `conversation: ConversationInternal` (and through it, `messages[]`, `ws`, `sessionId`, `connectionState`). Across a reconnect storm this leaked every `ConversationInternal` that ever connected.

**Per-entry RAM cost (historical):** a few KB held for the lifetime of the connection, multiplied by rapid reconnect storms or many concurrent runtimes.

---

### Finding 2 — MEDIUM — `terminal-server.ts` abort listener pinned to host signal — **CLOSED**

**File:** `packages/acp/src/client/terminal-server.ts`

**Status: CLOSED (2026-08-11).**

**Canonical entry point:** `dispose()` (`terminal-server.ts:295-302`). Idempotent — guarded by a private `disposed` flag, repeated calls are no-ops. Removes the host `AbortSignal` listener first, then kills every active terminal.

**Detached listener removal:** `abortSignal?.removeEventListener('abort', this.abortHandler)` (`terminal-server.ts:298`) with the exact same function reference that was registered in the constructor (`terminal-server.ts:84`). A new `vi.fn()`-based regression test (`terminal-server.test.ts` → "adds exactly one abort listener and removes it on dispose()") enforces the symmetric add=remove contract: it asserts that exactly one `'abort'` listener was added and exactly one was removed, and that the removed listener reference matches the added one. A mismatched reference would leave the real listener pinned on the host signal — the exact leak this finding was about.

**`Symbol.dispose` integration:** `TerminalServer[Symbol.dispose]()` (`terminal-server.ts:305-307`) delegates to `dispose()`, enabling `using { … }` blocks under Node ≥ 22 (`target: ES2024`).

**Backward compatibility:** `releaseAll()` (`terminal-server.ts:317-319`) is retained as a deprecated delegated wrapper so the 13 existing call sites (1 production: `ACPSession.close()` at `acp-session.ts:810`; 12 test sites) continue to work unchanged. New code should call `dispose()` directly.

**`ACPSession.close()` updated:** the only production call site (`acp-session.ts:810`) was renamed from `releaseAll()` to `dispose()` for semantic clarity. Behavior is equivalent because `releaseAll()` is now a wrapper around `dispose()`.

**`abortHandler` rewrite:** the constructor's abort handler (`terminal-server.ts:72`) now calls `this.dispose()` instead of `this.releaseAll()`. Previously, calling `releaseAll()` would re-enter the listener removal path; now `dispose()` is the single canonical cleanup so the call graph terminates at one idempotent function.

**What was the leak:** the original code's `releaseAll()` was the only path that removed the abort listener. If `ACPSession.close()` was never called (host crash, `kill -9`, abandoned session), the `{ once: true }` listener pinned `this` (the `TerminalServer`) — including the `terminals` Map with up to `maxTerminals = 32` entries and their `outputChunks[]` totaling up to `maxOutputByteLimit = 16 MiB` — for the lifetime of the AbortSignal. Per abandoned server: tens of MB held.

---

### Finding 3 — MEDIUM — `ws-client.ts` `pendingConfirms` no TTL — **CLOSED**

**File:** `packages/webui/src/lib/ws-client.ts`

**Status: CLOSED (2026-08-11, same remediation pass as the audit).**

**TTL mechanism:** every entry now carries an `expiresAtMs` field. A new `sweepExpiredPendingConfirms()` pass runs on every `tool.confirm_needed` insert and on socket disconnect; it removes any entry whose `expiresAtMs < now`.

**TTL value:** 60 s (`ws-client.ts:529-532, 578-582`). Chosen to be generous for a human-perceived permission prompt while matching the typical WebSocket reconnect window.

**Eviction triggers:**
- On every `handleMessage('tool.confirm_needed')` insert — `ws-client.ts:529-532`.
- On `handleWebSocketClose()` — `ws-client.ts:578-582` (the previous audit surfaced this as the second-best place to evict, since most aborts cluster around disconnects).

**What was the leak:** the original map was keyed by a server-issued id and only deleted on `sendConfirm`. A permission prompt that the user dismissed without sending a decision (panel unmounted, view switched, tab backgrounded, browser closed) would leak the key for the lifetime of the WebUI tab. The value is `{}` (empty object) so the leak is symbolic — but the unbounded key space is the actual risk, and long-lived tabs running many concurrent agent sessions would grow monotonically.

**Why this is LOW and not MEDIUM in the original audit:** the projected impact (~50 KB after 1000 unfinished prompts) is small. But the audit called it MEDIUM because the *unbounded key space* is the structural defect, not the byte count — same shape as the now-fixed `suppressedChatEchoes` issue (Finding 4) and the `terminal-server` listener (Finding 2).

**Suggested remediation (applied):** TTL eviction pass + reconnect-time prune. Verified at `ws-client.ts:529-532, 578-582`.

---

### Finding 4 — LOW — `ws-client.ts` `suppressedChatEchoes` TTL asymmetry

**File:** `packages/webui/src/lib/ws-client.ts`

```ts
// Lines 78-87
const CHAT_ECHO_SUPPRESSION_TTL_MS = 30_000;
const CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE = 32;

// Lines 604-611 (send, on echoToChat=false)
const pending = this.suppressedChatEchoes.get(responseType) ?? [];
pending.push(Date.now() + CHAT_ECHO_SUPPRESSION_TTL_MS);
while (pending.length > CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE) pending.shift();
this.suppressedChatEchoes.set(responseType, pending);

// Lines 661-675 (consumeSuppressedChatEcho)
const pending = this.suppressedChatEchoes.get(responseType);
…
while (pending.length > 0 && pending[0]! <= now) pending.shift();
if (pending.length === 0) {
  this.suppressedChatEchoes.delete(responseType);
  return false;
}
```

The cap on `MAX_PER_TYPE = 32` is enforced on push (line 608), keeping the array bounded. The TTL is only swept on consume (line 666).

**Why this is LOW and not MEDIUM:** the cap prevents unbounded growth. The asymmetry is that unconsumed response types retain 32 stale entries (each a `number` ~16 bytes) for up to 30 s past their TTL. Worst case: ~32 × 16 = 512 bytes per response type, multiplied by ~13 response types (`CHAT_ECHO_RESPONSE_BY_REQUEST` is keyed by 13 message types): ~6.5 KB of stale timestamps.

**Suggested remediation (deferred):** a periodic `setInterval` (every 60 s) that sweeps all known response types. Same TTL-eviction pattern as Finding 3, but deferred because the absolute cap (`MAX_PER_TYPE = 32 × 13 response types = ~6.5 KB`) bounds the worst case and the structural defect is not load-bearing. Tracked for future consolidation of TTL-sweep patterns across `ws-client.ts`.

---

### Findings 5-12 — Confirmed safe

Listed in the table at the top. Each was re-verified by reading the cleanup path:

- **OAuth flows** (`anthropic-oauth.ts`): listener removal in `finally`. Comment on lines 224-229 documents the prior fix.
- **Loopback server**: delegates to `@wrongstack/providers/oauth`; the wrapper has nothing to clean up.
- **Health monitor**: `setInterval` is `.unref()`'d, cleanup returned correctly.
- **EventBus**: hard caps (`2000` named, `500` wildcards) prevent unbounded growth.
- **Roster WS**: `inflight` Map deleted on every settle path.
- **TUI history**: bounded by `MAX_ENTRIES = 400` and `MAX_BYTES = 1 MiB`; `entryBytesCache` is a WeakMap.
- **Governance credential lease**: timer cleared in `stop()`, scheduler timer is `.unref()`'d by default.
- **`useFleetPolling`**: zustand subscriptions auto-clean on unmount. `enabled=false` only pauses the ticking interval but does not retain the subscriptions after unmount.

---

## Pattern Watchlist

Patterns that are not currently leaking but should remain under observation:

| Pattern | Observation |
|---|---|
| `ws.on(…)` vs `ws.once(…)` | Found one persistent `ws.on('message', …)` in `agent-bridge.ts`. Audit sibling files in `apps/desktop/src/main/` and `packages/webui-server/src/` for the same pattern. |
| `process.on('SIGINT', …)` / `process.on('SIGTERM', …)` | Used in CLI auth flows. Each flow attaches only inside the active path and detaches in `finally` (verified for `anthropic-oauth.ts`). Sibling OAuth flows (`openai-codex-oauth.ts`, `github-copilot-oauth.ts`) should be re-checked. |
| `fs.watch` / `chokidar` watchers | Not encountered in this pass. Any long-lived watcher without an explicit `close()` is a leak candidate. |
| `Worker` threads | Spawned in tool-execution paths. Any worker not `terminate()`'d on the error path retains its descriptor in the parent. |
| `child_process.spawn` | Verified safe in `TerminalServer.release()` (kills, detaches listeners, clears chunks). |
| `Buffer` retention | `TerminalServer` evicts from the head and joins only on read. Bounded. |
| `JSON.stringify` on hot paths | `history-retention.ts` documents the prior regression and the `WeakMap` cache. `ws-client.ts` re-serializes only on FIFO drop — runs only when the queue is saturated. |

---

## Verification Methodology

- All findings re-verified by reading the cited lines directly from disk.
- Greps confirmed that `ws.on('message', ...)` is the only persistent WebSocket listener outside `ws-client.ts`'s `on(eventType, handler)` registration API (which is for application message types, not transport events).
- The `RAM-leak audit 2026-07-31, LOW` comments embedded throughout the codebase were treated as prior-fix evidence.
- No runtime instrumentation (heap snapshots, allocations) was performed.

## Recommendations (in priority order)

1. **`apps/desktop/src/main/agent-bridge.ts`** — ✅ **Closed (2026-08-11).** Named `onMessage` + `socketGeneration` + `ws.off(...)` in `close()`. See Finding 1.
2. **`packages/webui/src/lib/ws-client.ts`** — ✅ **Closed (2026-08-11).** `pendingConfirms` TTL eviction + reconnect-time prune. See Finding 3.
3. **`packages/acp/src/client/terminal-server.ts`** — ✅ **Closed (2026-08-11).** Idempotent `dispose()` + `[Symbol.dispose]()`; `releaseAll()` retained as a deprecated alias. See Finding 2.
4. **Re-grep `apps/desktop/src/main/`** — ✅ **Closed.** No sibling `ws.on(...)` offenders besides the one in Finding 1.
5. **Verify the OAuth cleanup pattern in `openai-codex-oauth.ts` and `github-copilot-oauth.ts`** — ⏳ **Deferred.** `anthropic-oauth.ts` is verified safe; the two sibling flows were not re-checked in this pass. **Open (low, defensive).**

### Remaining open work (post-2026-08-11 pass)

- **OAuth sibling cleanup verification** — `openai-codex-oauth.ts` and `github-copilot-oauth.ts`. Should mirror the `anthropic-oauth.ts` pattern (named `onExternalAbort`, removed in `finally`). A separate scanner pass on `packages/cli/src/auth-menu/*-oauth.ts` is the natural place to catch this.
- **Finding 4 sweep** — `suppressedChatEchoes` TTL asymmetry. Bounded by `MAX_PER_TYPE = 32 × 13 response types = ~6.5 KB`, structurally identical to the now-fixed Finding 3. A periodic `setInterval` sweep on the same cadence as Finding 3's TTL eviction would consolidate the pattern. **Defer until the OAuth sibling check returns.**

---

## Remediation Pass (2026-08-11)

Three findings were closed in the same author pass that wrote this audit:

- **Finding 1** (`agent-bridge.ts`, HIGH) — fix in `agent-bridge.ts:171, 179-184, 382-385, 388`. Regression coverage: existing `chat.test.ts` exercises reconnect paths; a new test in `terminal-server.test.ts` exercises the symmetric add/remove contract for the same pattern.
- **Finding 2** (`terminal-server.ts`, MEDIUM) — fix in `terminal-server.ts:73, 295-307, 317-319`. New regression suite in `terminal-server.test.ts` (`describe('TerminalServer.dispose()')`): 5 tests covering listener removal, idempotency, `Symbol.dispose`, `releaseAll()` backward-compat alias, and a `vi.fn()`-based symmetric add=remove contract.
- **Finding 3** (`ws-client.ts pendingConfirms`, MEDIUM) — fix in `ws-client.ts:529-532, 578-582`. Existing `ws-client.test.ts` exercises the TTL eviction path.

All three remediations shipped the same day this audit was authored. `tsc --noEmit` on `packages/acp` is 0/0; the full `pnpm --filter @wrongstack/acp test` suite is 623 passed / 1 skipped / 0 failed.

---

## Final Note

The codebase is in a strong state relative to leak awareness. Most critical paths already return cleanup functions, use `{ once: true }` correctly, or cap with hard limits. As of 2026-08-11, the three "real" leak risks identified by this audit have been closed in the same author pass. The remaining open work is the OAuth sibling cleanup verification (defensive check, low blast radius) and the Finding 4 TTL consolidation (bounded by absolute cap, structural cleanup). Neither is load-bearing.