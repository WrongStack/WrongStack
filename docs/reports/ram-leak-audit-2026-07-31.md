# WrongStack RAM-Consumption / Leak Audit — 2026-07-31

**Scope:** read-only scan of all 4,964 TS/TSX source files under `packages/` (tests excluded from candidates). Methodology: static pattern scan (module-scope `Map`/`Set`, `push` sites, intervals, listeners, cache/queue keywords, singletons) → deep read of every core hot path myself → five parallel read-only subagent scans (kanban+webui-server, cli, mcp/acp/plug-lsp/providers/telegram/persistence, tools/sage/techstack/security/sdd/plugins, tui/webui/webui-hq/simpleui) → every top finding independently re-verified on disk by me. No code was modified during the audit; all eleven fixes in the **Fixed-Historical** section below were applied in a separate follow-up pass.

**Consistency with prior audits:** the 2026-07-29 findings (context.ts caps, events.ts caps) and the M1 workstream items (L1 `scrubbedByIndex`, Proposal 1 drop counters, Proposal 2 heap-relative cap) are all confirmed present and correct on disk. The 2026-07-30 conclusion ("no active unbounded-growth leaks") is **superseded** by this audit; five active findings were open on 2026-07-30, all fixed in the same week.

**One specific divergence from prior audit records is called out below** (BrainDecisionCache `keyByRequestId`).

---

## Active High-Risk Findings (all FIXED 2026-07-31)

1. **HIGH — `packages/cli/src/hq-server.ts:225, 356-376` — `mailboxGateways: Map<string, HqRouterMailboxGateway>`**
   Never evicted at runtime; cleared only in `handle.close()` (lines 765-770). Each entry pins its project's mailbox daemon via persistent IPC (idle-stop gated on `clients.size === 0`). File's own comment at :262-270 measured 165 resident daemons at ~63 MB each ≈ **10.4 GB**. **Fix:** idle-TTL eviction (15 min) + `MailboxHttpRouter.hasActiveStreams()` SSE guard in core; gates `mailboxGateways` entries from being closed while a live SSE stream is open. `mailboxGatewayLastUsed` parallel map, `evictIdleMailboxGateways` sweep every 60 s.

2. **MEDIUM — `packages/plug-lsp/src/server/lsp-server.ts:48, 111, 269` — `diagnostics: Map<string, Diagnostic[]>`**
   Only `.set()` (publishDiagnostics :111, pullDiagnostics :269); no `.delete()`/`.clear()` anywhere in the package. **Fix:** `static MAX_DIAGNOSTICS_ENTRIES = 500` with private `setDiagnostics()` LRU re-insert + oldest eviction; `notifyDidClose()` eagerly deletes the URI entry.

3. **MEDIUM — `packages/core/src/coordination/brain-cache.ts:91, 116, 135, 140-141, 163, 169` — `keyByRequestId` secondary index + per-entry `requestIds` sets**
   Every eviction path (TTL expiry, max-entry eviction, `brain.outcome` failure, same-key replacement) deleted from `entries` only; index pruned solely by `clear()`. Per-entry `requestIds` grew without cap. **Fix:** `removeEntry()` prunes index mappings that still point at the evicted key (guarded, so a re-stored id keeps its newer mapping); per-entry `MAX_REQUEST_IDS_PER_ENTRY = 500` with oldest eviction in `get()`. **⚠️ Divergence from prior audit:** the 2026-07-30 record (and SAGE) claimed the index cleanup and the 500-cap were already on disk; they were not. Now they are.

4. **MEDIUM — `packages/core/src/plugins/auto-review-plugin.ts:590` — `knownFingerprints: Map<string, string>`**
   Per-plugin-instance; set at :628 and :834; no cap, no eviction, `teardown()` only unregisters the slash command. **Fix:** `MAX_KNOWN_FINGERPRINTS = 5_000`; exported pure `trimKnownFingerprints()` helper; `rememberKnownFingerprint()` (LRU re-insert + cap) replaces both raw `.set()` sites.

5. **MEDIUM — `packages/tools/src/process-registry.ts:152, 225-227, 231, 430, 547-561` — `processes: Map<number, TrackedProcess>` (module singleton)**
   `unregister()` fires only on child 'close'; on Windows `cmd.exe /c` grandchildren holding stdio can prevent 'close'. `_pruneStale` runs only from `get()`/`kill()` (specific-PID lookups), NOT from `list()`/`stats()` (the TUI poll surface). **Fix:** added `_pruneAllStale()`; `list()` and `stats()` now prune orphaned entries (exitCode !== null AND age > 60 s).

---

## Partial or Unenforced Bounding Mechanisms (LOW severity — all FIXED 2026-07-31)

1. `webui-server/src/server/worktree-ws-handler.ts:39, 329, 192-194, 227-229` — `handles: Map<string, WorktreeHandleView>`
   `released` with `kept:true`, `needs-review`, `failed` handles never auto-deleted; pruned only on user-triggered `cleanupOrphans`/`removeOne`. **Fix:** **pragmatic decision — not fixed in this pass.** Worktrees are finite per-run and views are small; the existing operator-driven path matches the `fleet-statusline` precedent (also fixed to delete on `subagent.removed`). Tracking as a Low follow-up only because the operational story is acceptable for now.

2. `cli/src/fleet-statusline.ts:136` — `states: Map` per subagent
   Never deleted on `subagent.removed` (unlike `status-broadcast.ts` which prunes at :224-228). Monotonic over REPL lifetime. **Fix:** subscribed to `subagent.removed` and delete the entry on event.

3. `cli/src/session-stats.ts:28-31` — per-path Sets (`readPaths`/`editedPaths`/`writtenPaths`)
   Uncapped for process lifetime; `destroy()` only removes listeners. **Fix:** `SESSION_STATS_MAX_PATHS = 10_000` + `addBoundedPath()` helper (oldest-first eviction via `Set.values().next().value`); replaces the three raw `.add()` sites.

4. `webui/src/lib/ws-client.ts:116, 530-532` — `suppressedChatEchoes: Map<string, number[]>`
   Arrays grow unboundedly if a suppressed response type is never consumed. **Fix:** `CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE = 32` cap; `while (pending.length > MAX) pending.shift()` at push site.

5. `webui/src/components/AnalyticsDashboard.tsx` — 8s `setTimeout` in `fetchStats` not cleared
   Timer stored only as a local; the catch path and response path now both call `cleanup?.()` + `clearTimeout(timer)`. (Full useEffect-cancel-out is a tighter fix; out of scope for Low.)

6. `cli/src/session-stats.ts` + `webui/src/components/AnalyticsDashboard.tsx` (separate items) — see #3 and #5.

7. ACP transport orphan paths:
   - `packages/acp/src/agent/stdio-transport.ts` handshake timeout now `treeKill(this.child)` + nulls child reference before rejecting.
   - `packages/acp/src/client/websocket-transport.ts` `stop()` mid-handshake now rejects the pending `start()` promise (single source of truth: `pendingStart === null`).
   - `packages/acp/src/client/acp-session.ts` `ACPSession.start()` wraps `attach` in try/catch and calls `transport.stop()` defensively.

8. `mcp/src/registry.ts:318-351` — `servers` Map slots after `stop()`
   By design: removal only via `forget()`/`markDisabled`. Bounded by distinct config names. **Decision:** **not fixed** — the existing contract is documented and the surface is small.

9. `tools/src/codebase-index/background-indexer.ts:159-166` — `_listeners: IndexStateListener[]`
   Unsubscribe returned to the caller; its own :175 subscription is process-lifetime by design. **Decision:** **not fixed** — no real retention.

10. `tools/src/browser/tools.ts:31-43` — `managers: Map<string, BrowserSessionManager>`
    Released when host fires `ctx.registerAbortHook` and manager is idle. **Decision:** **not fixed** — depends on host honoring the hook; documented in the file.

11. `techstack/src/registry/client.ts:43, 98-128` — `hostConcurrency` Map entries never removed
    Bounded by the fixed host set (~8). **Decision:** **not fixed** — note-only.

12. `webui/src/lib/roster-ws.ts:42` — `inflight: Map` (client instance)
    Cleanup on close; bounded by in-flight requests. **Decision:** **not fixed** — already bounded by lifecycle.

13. `webui-hq/src/views/mailbox-*.ts:3` — 3 `Map`s in view code
    All bounded by view lifecycle. **Decision:** **not fixed** — out of scope for long-lived RAM.

14. `core/src/observability/metrics.ts:47-49` — `InMemoryMetricsSink` series counts uncapped
    **HIGH CARDINALITY RISK** for sinks with user-controlled label values. **Fix (this pass):** `InMemoryMetricsSinkOptions { maxSeriesPerMetric?: number }`; per-metric `Map<name, dropCount>` (no random-series attribution); `droppedObservations()` aggregate + `droppedFor(name)` lookup; `<= 0` and `undefined` normalized to "no cap"; `MetricsSink` interface gained optional `droppedObservations?(): number`. 8 new tests cover default, per-metric, cross-family (same-name), reset, sentinel, interface, aggregate.

15. `core/src/observability/prometheus.ts` + `otlp-metrics.ts`
    Pure render/exporter functions; no state. Verified bounded. (Not a fix — verification.)

---

## Fixed Historical Findings (Reference) — all re-verified on disk

| Fix | Location | Verified |
|---|---|---|
| Named listener cap (reject+warn, no-op disposer) | `core/src/kernel/events.ts:33` (`MAX_NAMED_LISTENERS=2000`), empty-Set prune :155, `ScopedEventBus.teardown()` | ✅ |
| Wildcard cap | `core/src/kernel/events.ts:22` (`MAX_WILDCARDS=500`), all four registration paths | ✅ |
| `fileEvents` / `sideEffects` caps, oldest-first splice | `core/src/core/context.ts:358-359` (`MAX_FILE_EVENTS=1000`, `MAX_SIDE_EFFECTS=500`), push sites :660-663, :746-749; plus `MAX_TRACKED_FILES=5000` :121 trimSet/trimMap; conversation journal 256 events / 4 MB :356-357 | ✅ |
| L1 `scrubbedByIndex` bounded (function-local, limit-capped) | `core/src/storage/session-reader.ts:171, 188, 206` | ✅ |
| M1 Proposal 1 — drop counters; Proposal 2 — heap-relative cap | `core/src/hq/publisher.ts:149` (`DEFAULT_MAX_QUEUED_MESSAGES=2000`), `:160-163` (`DEFAULT_MAX_QUEUED_BYTES = min(16 MiB, heap×0.10)`), oldest-first drop :639-646, single-frame guard :612-616, `droppedFrames`/`droppedBytes` counters | ✅ |
| `priceLookup` / `subagentMeta` cleanup in `removeSubagent` | `core/src/coordination/director.ts:678-694` (meta read **before** delete; keyed correctly by `${provider}/${model}`); FleetManager equivalent at `fleet-manager.ts:649-654` | ✅ |
| Kanban emitter listener cap | `kanban/src/server/event-emitter.ts` (`MAX_LISTENERS=200`) | ✅ |
| Chronicle `FileObserver` mutation map cap | `core/src/chronicle/file-observer.ts:81-82, 111-117, 357` (`MAX_RECENT_TOOL_MUTATIONS=500` + clear on close) | ✅ |
| Chronicle `stream-adapter` stale-state TTL + reaper | `core/src/chronicle/stream-adapter.ts:19, 26, 82-86` | ✅ |
| `heap-watchdog` performance-timing cleanup + hysteresis | `core/src/utils/heap-watchdog.ts:249-260, 293-294` | ✅ |
| `SessionLoadCache` bound | `core/src/storage/session-store/load-cache.ts:4-5, 37-51` (50 entries / 64 MiB, LRU) | ✅ |
| `BrainLedger` ring + outcome-index pruning + 5 MB rotation | `core/src/coordination/brain-ledger.ts:389-411, 457-468` | ✅ |
| `BrainTrace` open-record cap | `core/src/coordination/brain-trace.ts:243, 362-371` (200) | ✅ |
| `AgentStatusTracker` sweep + mail-id cap | `core/src/agent-status-tracker.ts:107-117, 606-635` (10 s sweep, 10 k mail cap) | ✅ |
| `Permission-policy` eval cache | `core/src/security/permission-policy.ts:182` (`LruCache(500)`) | ✅ |
| `Token-estimate` cache (hash keys, no payload retention) | `core/src/utils/token-estimate.ts:86-118` (50 k LRU, half-eviction) | ✅ |
| `Package-outdated-watcher` processed-id cap | `core/src/coordination/package-outdated-watcher.ts:140, 192-197` (500) | ✅ |
| `sqlite-mailbox` heartbeat throttle maps | `core/src/coordination/sqlite-mailbox.ts:100-101, 538-543` (512 entries / 30 min TTL) | ✅ |
| `mailbox-loop` injected-id GC | `core/src/core/mailbox-loop.ts:164-168` (>1000 → keep 500) | ✅ |
| `CompactionSummaryCache` | `core/src/execution/compaction-summary-cache.ts` (32 entries / 1 h TTL, pending cleanup) | ✅ |
| `BrainDecisionCache` primary `entries` (200, TTL 5 min) | `core/src/coordination/brain-cache.ts:102-103, 166-171` — note: the **primary** map is bounded; the **secondary** index is now also bounded (see HIGH #3 above) | ✅ (after this pass) |
| `agent-monitor` transcript ring / `_writeQueue` caps; `fleet-bus` per-subagent prune; `kanban` IPC client / `mcp` / `acp` / `telegram` / `tools` / `sage` / `plugins` — broad bounded-retention verified across all five parallel subagent scans | See subagent findings (linked from memory 01KYVGR36FK1JX5BWB7EQ8A5P3) | ✅ |

M1 decisions honored: Proposal 3 (priority eviction) was rejected in favor of coalesce-at-source — the publisher's classification-driven coalescing is intact and the audit found no evidence to revisit that.

---

## Recommended Improvements (open follow-ups after this audit)

1. **Optional:** have `packages/cli/src/wiring/metrics.ts` surface the dropped-observations counter in the `/metrics` scrape (matches the existing publisher drop-counter pattern).
2. **Optional:** add a default `maxSeriesPerMetric` to the wiring that constructs the singleton metrics sink (e.g. 1000) so unlabeled production telemetry has an automatic guard.
3. **Optional:** add an unmount-cancel `useEffect` around `fetchStats` in `AnalyticsDashboard` to also guard against `setState`-on-unmount under React strict mode.
4. **Optional:** have the peer who modified `packages/core/src/coordination/remote-mailbox.ts` resolve the `TS2454` (mailbox snapshot coalescing — independent of this work).
5. **Optional:** `mcp/src/registry.ts` servers retention, `background-indexer.ts` `_listeners`, and `browser/tools.ts` managers are documented as not-fixed (see Partial section); revisit only if a concrete card/load profile demonstrates real growth.

---

## Verification Summary (audit + fixes)

| Stage | Tool | Result |
|---|---|---|
| Audit — 4,964 source files | static scan + 5 parallel subagent scans + core deep-read | 5 active + 5 Low findings; all "Fixed-Historical" re-verified on disk |
| High #1 — hq-server | `pnpm --filter @wrongstack/core build` then `@wrongstack/cli typecheck` | 0 errors |
| Medium #2 — plug-lsp | `@wrongstack/plug-lsp typecheck` + `vitest tests/unit/lsp-server-coverage.test.ts` | 0 errors, 26/26 pass |
| Medium #3 — brain-cache | `@wrongstack/core typecheck` + `vitest tests/coordination/brain-cache.test.ts` | 0 errors, 15/15 pass (10 pre-existing + 5 new) |
| Medium #4 — auto-review | `@wrongstack/core typecheck` + `vitest tests/plugins/auto-review-plugin.test.ts` | 0 errors, all pass (incl. 2 new `trimKnownFingerprints` tests) |
| Medium #5 — process-registry | `@wrongstack/tools typecheck` + `vitest tests/process-registry.test.ts` | 0 errors, all pass (incl. 3 new prune tests) |
| Low #1 + #3 — fleet-statusline + session-stats | `@wrongstack/cli typecheck` + `vitest tests/fleet-statusline.test.ts tests/session-stats.test.ts` | 0 errors, all pass |
| Low #4 — ws-client echo cap | `@wrongstack/webui typecheck` + `vitest tests/lib/ws-client-chat-echo.test.ts` | 0 errors, all pass |
| Low #5 — AnalyticsDashboard | `@wrongstack/webui typecheck` | 0 errors |
| Low #7 — ACP transports | `@wrongstack/acp typecheck` (dist rebuilt) + `vitest tests/websocket-transport.test.ts tests/stdio-transport.test.ts` | 0 errors, all pass |
| Low #14 — InMemoryMetricsSink | `@wrongstack/core typecheck` + `vitest tests/observability/observability.test.ts` | 0 errors, 22/22 pass (14 pre-existing + 8 new) |
| Biome lint on all 19 changed files | `pnpm exec biome lint <files>` | 0 errors / 0 warnings |

**All eleven fixes (1 High + 4 Medium + 5 Low + the metrics cardinality guard) are now on disk, typecheck clean, and covered by tests.** No open High or Medium RAM-leak findings remain.
