# 03 — Execution Pipeline: Compaction, Council, Autonomy

**Package:** `@wrongstack/core` (execution layer)
**Files examined:** `compaction-core.ts` (1427 lines), `auto-compaction-middleware.ts` (844 lines), `council-orchestrator.ts` (1139 lines), `tool-executor.ts` (1051 lines), `tool-executor-support.ts`
**Severity:** Medium

---

## 1. Compaction Core: Complexity and Instrumentation

**File:** `packages/core/src/execution/compaction-core.ts` (1427 lines)

This is the largest file in the execution layer. It contains pure compaction primitives shared by three compactors (`HybridCompactor`, `IntelligentCompactor`, `SelectiveCompactor`).

**Verified instrumentation:** The file has instrumentation infrastructure (`CompactionMetrics` interface at line 45, `emitCompactionMetrics` at line 98, `compactionDebugEnabled` at line 81) tracking:
- `fastPathIterations` and `fastPathInnerIterations`
- `fullPassIterations` and `fullPassInnerIterations`
- Ratio tracking (`fastPathInnerPerOuter`, `fullPassInnerPerOuter`)

The metrics were exercised against realistic 1K/5K histories. HybridCompactor averaged 1.13 ms at 1,000 messages and 5.99 ms at 5,000; IntelligentCompactor averaged 5.02 ms at 1,000. A separate 5,000-message all-tool-pair regression recorded only two preserve repair iterations and two inner block iterations. The earlier claim that the repair loop might walk backward across an arbitrary number of tool pairs is rejected: after one repair the cursor points at an assistant message, forcing the next condition check to exit.

**Finding (Verified Good):** The `findPreserveStart` function (line 169) walks backward counting user/assistant messages until `preserveK` are covered, then walks forward to keep tool_use/tool_result protocol pairs intact. The repair loop (lines 186-196) ensures provider protocol adjacency is maintained after compaction.

**Disposition:** The requested 1K/5K load measurement is complete and the constant-bound repair invariant now has regression coverage. The 42 MB oversized-tool-result stress benchmark remains intentionally separate from normal-history latency; it is not evidence of a preserve-window defect.

---

## 2. Auto-Compaction Middleware: Cached Token Estimates

**File:** `packages/core/src/execution/auto-compaction-middleware.ts`, lines 120-131

```typescript
private _cachedTokens = -1;
private _cachedMsgCount = -1;
private _cachedToolCount = -1;
private _cachedRevision = -1;
private _cachedSystemRef: unknown = null;
private _cachedToolsRef: unknown = null;
```

**Verified:** The middleware caches the token estimate and reuses it when the message count, tool count, system prompt reference, and tools reference haven't changed. This avoids the expensive O(n) token estimation on autonomous idle loops where nothing changes between iterations.

**Finding (Low):** The cache invalidation uses reference identity for `_cachedSystemRef` and `_cachedToolsRef` (lines 130-131). If the system prompt or tools array is cloned (same content, different reference), the cache invalidates unnecessarily. This is a minor performance concern, not a correctness issue.

**Finding (Verified Good):** The `NOOP_RETRY_DELTA_TOKENS` (line 104, value 2000) prevents re-firing compaction when the last attempt reduced nothing. The middleware remembers the no-op attempt and skips until either the pressure level escalates or context grows by 2000 tokens. This prevents `compaction.fired` event spam.

---

## 3. Council Orchestrator: Multi-Model Voting

**File:** `packages/core/src/execution/council-orchestrator.ts` (1139 lines)

The council orchestrator runs a multi-seat voting system where multiple LLM "voters" with different personas evaluate a question, and a "judge" synthesizes the final answer.

**Verified:** The constructor requires at least one caller (`caller`, `seatCaller`, or `judgeCaller`). Ad-hoc profiles are normalized on every `ask()` call, so a caller that reuses and mutates a profile object cannot receive a stale object-identity-cached snapshot.

**Verified abort contract:** The overall timeout is enforced via `AbortSignal.timeout(profile.overallTimeoutMs)`, combined with the caller's signal via `AbortSignal.any`. Each seat gets the combined signal. The timeout distinction is important:

```typescript
const timedOut = signal.aborted && !question.signal?.aborted;
return {
  status: question.signal?.aborted ? 'cancelled' : 'failed',
  error: question.signal?.aborted ? CALL_CANCELLED_REASON : OVERALL_TIMEOUT_REASON,
};
```

This correctly distinguishes between caller cancellation and overall budget expiration. The production chain was traced end to end: Council passes the combined signal to `OneShotOrchestrator`, One Shot composes it with the per-call timeout and passes it to `provider.complete`, `WireAdapter` links it to the HTTP `fetch`, and AI Gateway passes it to the AI SDK as `abortSignal`. Delegate providers forward the same options object. A deliberately hanging provider regression proves that both an external abort and the per-call timeout interrupt an in-flight Council provider call.

**Disposition:** The draft SDK-cancellation concern is rejected for the registered provider implementations. Four focused Council/provider suites passed **107/107 tests**, including the hanging-provider abort regressions. A third-party provider can still violate the structural `Provider` contract at runtime, but that is an extension defect rather than a missing Council timeout mechanism.

---

## 4. Council: Refusal Option

**File:** `packages/core/src/execution/council-orchestrator.ts`, lines 32-34

```typescript
export const COUNCIL_REFUSAL_OPTION_ID = 'council_refuse';
```

**Verified:** The council includes a synthetic "refuse every real option" ballot entry. `validateRefusalCollision` (called at line 170) ensures no real option collides with the refusal ID. This prevents a malicious or buggy question from making "refuse" indistinguishable from a real answer.

---

## 5. Tool Executor: Timeout and Abort Handling

**File:** `packages/core/src/execution/tool-executor.ts`, lines 894-1004

The `runWithTimeout` method races the tool promise against a combined abort/timeout signal. The abort handler (line 969-976) uses `setTimeout(() => reject(...), 0)` to give a signal-honoring tool one macrotask of grace:

```typescript
const onAbort = () => {
  setTimeout(() => reject(abortReasonToError(combined.reason)), 0);
};
```

**Verified:** This is a clever pattern — the `setTimeout(..., 0)` defers the generic rejection by one macrotask, allowing a tool that has its own abort listener to reject with its own richer error first. The tool's error then wins the race because it's already in the microtask queue.

**Finding (Low):** After the race, line 999 checks `combined.aborted` again even on success:

```typescript
if (combined.aborted) {
  await this.runToolCleanup(tool, input, ctx);
  throw abortReasonToError(combined.reason);
}
```

This handles the edge case where a signal-ignoring tool resolves in the same tick the signal fires. The stale result is never returned as success. This is correct.

---

## 6. Tool Error Taxonomy

**File:** `packages/core/src/execution/tool-error-taxonomy.ts` (imported at line 31)

The `classifyToolError` function (re-exported at line 53) categorizes errors with `category`, `retryable`, and `detail` fields. This information is attached to span attributes (lines 663-665) and used by the agent loop for retry decisions.

**Finding (Verified Good):** The error taxonomy is used consistently — every error path in the executor either re-throws structured errors (`isWrongStackError`) or classifies them via `classifyToolError`. The `toolErrorResult` function produces a unified result block with structured error info.

---

## 7. Agent Learning: A-01 Cross-Category Directive Suppression

**File:** `packages/core/src/coordination/agents/project-agent-learning-structured.ts`, lines 324-332

**Bug confirmed (Medium):** The `mergeStructuredEntries` function filters overlapping entries by token overlap (≥0.55) without checking category:

```typescript
const overlapping = existing.filter((entry) => tokenOverlap(entry.key, key) >= 0.55);
const proven = overlapping.find(isProvenDirective);
if (proven) return sortStructuredEntries([...existing]); // <-- suppresses fresh entry
```

The `proven` check at line 331 searches across **all categories**. If a proven directive in category A (e.g., "code-style") has ≥55% token overlap with a fresh directive in category B (e.g., "testing"), the fresh directive is suppressed entirely. The category filter only appears later at line 339 for the ancestor inheritance path.

**Impact:** New learnings in one category can be silently suppressed by proven directives in a different category if they share enough tokens. Over time, this could prevent the agent from learning new directives in categories that have established proven directives with similar vocabulary.

**Fix:** Add a category filter to the proven check:
```typescript
const proven = overlapping.find((e) => e.category === fresh.category && isProvenDirective(e));
```

**Resolution (2026-08-10):** Implemented and regression-tested. Both proven suppression and overlap replacement now require the same category.

---

## Summary

The execution pipeline is well-instrumented and handles complex concurrency scenarios (parallel tools, council voting, timeout races) with careful attention to edge cases. Main findings:

1. **Compaction performance** — 1K/5K load measurement is near-linear; preserve repair is constant-bounded and regression-tested
2. **Council timeout** — production provider paths forward abort end to end; hanging-provider regressions pass
3. **Cross-category directive suppression** — confirmed bug in agent learning system (line 331)
4. **Error taxonomy** — well-designed, consistently applied
