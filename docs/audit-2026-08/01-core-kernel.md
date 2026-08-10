# 01 — Core Kernel Audit

**Scope:** `packages/core/src/core/` (agent loop, context, agent internals, response, tools, types), `packages/core/src/execution/` (tool executor, compaction, council, autonomy, prompt-enhancer)

---

## Agent Loop (`agent-loop.ts`, 1167 lines)

### Architecture

The agent loop is the central execution engine. It:
1. Builds the request (messages + system prompt + tool definitions)
2. Calls the LLM provider
3. Parses the response into text + tool_use blocks
4. Executes tool batches via `ToolExecutor.executeBatch()`
5. Appends results to the conversation
6. Repeats until the model stops requesting tools or an abort fires

### Verified Behaviors

- **Abort signal handling:** The loop checks `ctx.signal.aborted` at the top of each iteration and between tool batches. The `runWithTimeout` method in the tool executor races the tool promise against the abort signal with a one-macrotask grace period (line 975), allowing signal-honoring tools to surface richer errors.

- **Structured error preservation:** `isWrongStackError(err)` is checked in both `runOne`'s catch (line 645) and `safeRun`'s catch (line 688). Structured errors are re-thrown from `runOne` so `safeRun` can render them via `err.describe()` — preserving `code`, `subsystem`, `severity`, `recoverable`, and `context`.

- **Tool adjacency repair:** `repairToolUseAdjacency` is called before sending messages to the provider, ensuring every `tool_result` has a preceding `tool_use`.

### Finding A-01 (Medium): Cross-Category Directive Suppression

**File:** `packages/core/src/coordination/agents/project-agent-learning-structured.ts:325–331`

```typescript
// Line 325: overlapping is category-AGNOSTIC
const overlapping = existing.filter((entry) => tokenOverlap(entry.key, key) >= 0.55);

// Line 331: proven check finds ANY proven directive across ALL categories
const proven = overlapping.find(isProvenDirective);
if (proven) return sortStructuredEntries([...existing]); // SUPPRESSED
```

**Impact:** A proven directive in category `preference` ("always use tabs") suppresses a fresh directive in category `anti_pattern` ("never use tabs for YAML") if they share ≥55% of tokens. The category filter only appears later (line 339) for ancestor inheritance, not for the proven-suppression path.

**Fix:** Add a category filter to the `overlapping` set used by the proven check:
```typescript
const proven = overlapping.find(
  (entry) => entry.category === fresh.category && isProvenDirective(entry)
);
```

**Resolution (2026-08-10):** Implemented. The proven-directive lookup and the later overlap-replacement filter are both category-scoped. A regression test covers identical-token entries in different categories.

### Finding L-01: Council Profile Cache Mutation Risk

**File:** `packages/core/src/execution/council-orchestrator.ts:121`

```typescript
private readonly profileCache = new WeakMap<CouncilProfileConfig, ResolvedCouncilProfile>();
```

The comment (lines 116–120) warns: "Hosts must treat ad-hoc profile configs as IMMUTABLE once passed to `ask()`: the cache is keyed by object identity and never invalidated." There is no runtime enforcement. A host that mutates the profile object (e.g., changing seat count) will get stale resolution.

**Resolution (2026-08-10):** Implemented by removing the identity-keyed cache for ad-hoc profiles. Profiles are normalized on every `ask()` call, so reusing and mutating a config object cannot return stale seats. A regression test exercises the same object before and after mutation.

---

## Tool Executor (`execution/tool-executor.ts`, 1051 lines)

### Architecture

The executor pipeline for a single tool call:
1. **Registry lookup** — unknown tool fast-path
2. **Malformed arguments detection** — sentinel key check before schema validation
3. **Schema validation** — with one-pass type coercion (string "5" → 5)
4. **PreToolUse hooks** — can block or rewrite input (re-validated if rewritten)
5. **Cross-field validation** — `tool.validate()` for invariants schemas can't express
6. **Kanban boundary** — `evaluateToolKanbanBoundary()` enforcement
7. **Permission policy** — `evaluate()` returns auto/confirm/deny
8. **Dangerous capability downgrade** — auto → confirm for dangerous caps outside YOLO
9. **Confirmation flow** — interactive or pending
10. **Execution** — `produceToolOutput()` (async) → `settleToolOutput()` (sync budget)

### Verified: Produce/Settle Split

The produce phase (line 828) runs the tool, serializes output, scrubs secrets, and spills to disk — all async, touching no shared budget state. The settle phase (line 866) is synchronous: it reads the live budget, calls `enforceCap`, and writes back the reduced budget. This correctly prevents the parallel-tool budget race where N tools each read the same stale starting budget.

### Verified: Governed Execution Bridge

The `withGovernedExecutionBridge` pattern (line 752) installs a bridge in `ctx.meta` that meta-tools use for nested calls. The bridge re-enters `executeBatchInternal` with `'sequential'` strategy, ensuring nested calls traverse the same validation/permission/scrub path. The previous bridge is preserved and restored in `finally`.

---

## Compaction System (`execution/compaction-core.ts`, 1427 lines)

### Architecture

Three compactors share pure primitives from `compaction-core.ts`:
- `findPreserveStart()` — walks back `preserveK` user/assistant pairs, then repairs tool_use/tool_result adjacency
- `elideOversizedToolResults()` — fast-path + full-pass elision
- `buildSmartDigest()` — scoring-based content summarization
- `collapseAcknowledgedToolReceipts()` — deduplicates acknowledged results

### Verified: Preserve-Window Repair Is Constant-Bounded

**File:** `packages/core/src/execution/compaction-core.ts:186–196`

```typescript
while (preserveStart > 0) {
  pairRepairIterations++;
  const first = messages[preserveStart];
  const prev = messages[preserveStart - 1];
  if (!first || !prev || first.role !== 'user' || prev.role !== 'assistant') break;
  // ...hasMatchingToolPair scans every block in both messages
  pairRepairInnerIterations += pairCheck.iterations;
  if (!pairCheck.matched) break;
  preserveStart--;
}
```

The draft interpretation was wrong: after one matching `user(tool_result) → assistant(tool_use)` repair, `preserveStart--` points at the assistant message. The next loop iteration immediately exits because `first.role !== 'user'`. The outer repair loop is therefore bounded to two iterations (one match plus one terminating check), independent of conversation length; it cannot walk across an arbitrary chain of tool pairs.

**Measured (2026-08-10):** A 5,000-message alternating tool-use/tool-result history produced `pairRepairIterations = 2` and `pairRepairInnerIterations = 2`. A regression test pins that invariant. Existing compactor benchmarks measured HybridCompactor at a 1.13 ms mean for 1,000 messages and 5.99 ms for 5,000 messages on this host, showing the expected near-linear whole-pass scaling. The proposed arbitrary iteration cap is rejected because there is no unbounded repair scan to cap.

---

## Auto-Compaction Middleware (`execution/auto-compaction-middleware.ts`, 844 lines)

### Verified: Token Estimate Caching

Lines 126–131 cache the token estimate when message count and tool count haven't changed. This is correct for autonomous idle loops where the context doesn't grow between iterations.

### Verified: No-Op Retry Suppression

Lines 104–106 define `NOOP_RETRY_DELTA_TOKENS = 2_000`. Once a compaction attempt reduces nothing, it skips until either pressure escalates or context grows by 2K tokens. This prevents `compaction.fired` event spam.

---

## Council Orchestrator (`execution/council-orchestrator.ts`, 1139 lines)

### Architecture

Multi-seat LLM voting system with:
- Per-seat LLM callers (optional `seatCaller` factory)
- Separate judge caller
- Ad-hoc profile normalization with WeakMap cache
- Overall timeout via `AbortSignal.timeout(profile.overallTimeoutMs)`
- Canonical error texts for timeout/cancel dedup

### Verified: Timeout vs. Cancel Distinction

Line 190: `question.signal?.aborted` distinguishes caller cancel (status: 'cancelled') from overall budget expiry (status: 'failed'). This is correct — the envelope reason uses the canonical `OVERALL_TIMEOUT_REASON` vs `CALL_CANCELLED_REASON`.
