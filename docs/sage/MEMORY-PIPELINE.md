# SAGE + Vector Memory — the full retrieval-to-context pipeline

Date: 2026-09-03 · Source-verified against `packages/sage`, `packages/vector-memory`, `packages/cli`, `packages/webui-server`, `packages/core`.

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) (storage engine) and
[`../sage-memory-analysis-2026-08-08.md`](../sage-memory-analysis-2026-08-08.md) (store-level analysis).
This document covers the part neither of those does end to end: **how a stored memory
becomes tokens in the model's context**, and where that path was broken.

---

## 1. The five stages

```
 write ──► store ──► recall ──► gate ──► render
```

| Stage | Owner | Entry point |
|---|---|---|
| write | agent tools, capture middleware, triage | `rememberSqliteSage`, `outcome-capture.ts`, `session-end-commit-extractor.ts` |
| store | SAGE daemon (sole SQLite owner) + vector sibling DB | `sqlite-store*.ts`, `vector-memory/src/store.ts` |
| recall | 4 channels, fused | `retrieveTriggeredMemories`, `searchSqliteSage`, `augmentLexicalWithVectorRecall` |
| gate | scoring + diversity + cooldown | `tool-call-memory-scoring.ts`, `selectDiverseMemories`, `applyCooldown` |
| render | fenced evidence block | `formatMemoryHintsDetailed` |

Only two surfaces ever put memory into the model's context:

- **`sage.tool-result-injection`** (`toolCall` pipeline) — default **on**. Appends an
  evidence block to a *tool result*.
- **`sage.turn-context`** (`request` pipeline) — default **off** (`Sage.inject.turnContext`).
  Appends a `cache_control: ephemeral` system block.

Everything else in the package — hygiene, triage, candidates, the graph, the audit log,
domain terms — feeds those two or is operator-facing.

---

## 2. Recall: four channels

`retrieveTriggeredMemories` fans out per tool call and unions by memory id, keeping the
**max** relation strength per id.

| # | Channel | Signal | Strength |
|---|---|---|---|
| 1 | **Path anchors** — `retrieveForPath` per touched path | `pathAnchorRelation` | 0.95–0.98 exact, decayed 0.35–0.95 for ancestors |
| 2 | **Lexical** — `searchSage(enrichPathQuery(paths) + pattern)` | `memoryQueryRelevance` | 0.66–0.98 |
| 3 | **Graph** — `findRelatedSage` seeded from ≥0.9 hits, depth 2 | `memoryStructuralRelevance` | 0.72 / 0.86 |
| 4 | **Semantic** — vector recall fused into channel 2 | `memorySemanticRelevance` (cosine) | 0.85 at cosine 0.75, capped 0.94 |

Channel 2 itself is two-layer: FTS5/bm25 inside SQLite, then `hybridRerankMemories`
(offline 256-dim hashing embeddings) reorders the hits, then the vector channel fuses.

### The relation floor is the real gate

`relationFloor` defaults to **0.85**, and it is checked *before* the composite score.
Against `memoryQueryRelevance`'s tiers that admits only:

- an exact anchor value appearing verbatim in the query (0.96 / 0.98)
- ≥2 anchor-term matches (0.88+)
- ≥3 tag matches (0.89)
- ≥5 matched text terms covering ≥60% of the query (0.86)

Everything else in channel 2 is rejected. This is why the system is precise, and it is
the safety net that lets the MATCH itself be generous.

**Semantic hits are judged on the same scale.** `memoryQueryRelevance` measures shared
surface tokens, so a memory the vector channel found and the lexical channel missed scores
0 there *by construction* — it was recalled precisely because it shares no tokens.
`memorySemanticRelevance` maps cosine onto the same 0–1 relation scale, pinned so that
cosine 0.75 lands exactly on the default `relationFloor`:

| cosine | strength | at default floor |
|---|---|---|
| 0.55 | 0.72 | rejected |
| 0.75 | 0.85 | admitted (pivot) |
| 0.90 | 0.95 | admitted |
| 1.00 | 0.94 (capped) | admitted |

Both injection surfaces take `max(lexical, semantic)`, so a memory found by both channels
keeps whichever evidence is stronger, and there is **no second semantic threshold to
forget** — moving `relationFloor` moves all three channels together.

---

## 3. Gate

In order, per tool call:

1. `dedupeRetrievedByText` — normalized-text duplicates
2. `importance < minImportance` (0.5)
3. `relationStrength < relationFloor` (0.85)
4. `contextualInjectionScore < minScore` (0.72) — `0.48·metadata + 0.48·relation`, plus
   persistence / durable-kind / use-count / anchor boosts and an **unused-after-3-injections
   penalty**
5. `containsMemoryText` — already visible in the result or system prompt
6. `applyCooldown` — once per session by default (`repeatCooldownMs: 0`)
7. `selectDiverseMemories` — ≤3 per kind, ≤2 query-only, ≤1 graph-only
8. `availableHintChars` — must fit the tool's `maxOutputBytes`

Every rejection is traced (`memory.injector_trace`), and three `belowScore` rejections of
the same memory inside 5 minutes emit `memory.injector_rejection_burst`.

### The feedback loop

`InjectionTracker` registers each injected memory. On the next turn, `sage.turn-context`
scans the assistant message for an id citation, a long phrase, or ≥0.5 token overlap and
credits `recordUse`. `recordUse` raises the score; `injectionCount` without `useCount`
lowers it and eventually makes hygiene archive the memory. **This is the only signal in the
system that distinguishes useful memory from noise** — it is what makes the corpus
self-pruning.

---

## 4. What was broken

### 4.1 The semantic channel was dead in every production surface — Critical

`wrapMemoryPortWithVectorRecall` merged the recall provider into the **search options**:

```ts
{ ...options, vectorRecall: { search: async (q, o) => …} }
```

and let `SqliteSageStore.searchSage` do the fusion. That works only when the store is
in-process. In production it never is: `createProjectSageMemoryPort` returns a
`ProjectSageMemoryPort` speaking line-delimited JSON to the per-project daemon
(`encodeSageProjectServerMessage` = `JSON.stringify`).

```
JSON.stringify({ vectorRecall: { search: fn } })  →  {"vectorRecall":{}}
```

Functions do not survive the wire. The daemon received a **truthy but empty** provider,
passed the `if (!opts?.vectorRecall) return lexical` guard, called `.search(...)`, threw
`search is not a function` inside the fusion's fail-open `try`, and returned the lexical
list. No error surfaced anywhere: the store logged nothing, the wrapper reported success,
and `searchSageWithBreakdown` faithfully reported every hit as `source: 'lexical'`.

The ONNX model was downloaded, the corpus was mirrored, the vector DB was written on every
SAGE write — and **not one query ever read it back**.

**Fix.** The fusion now runs on the host side of the IPC boundary
(`packages/vector-memory/src/sage-port-wrapper.ts`):

1. call the port's `searchSage` (remote or in-process) for the lexical list,
2. query the local vector store,
3. fuse with RRF via `augmentLexicalWithVectorRecall`,
4. resolve semantic-only hits by id through `SageSurface.getSage`, re-applying every
   visibility rule the lexical channel enforces in SQL.

Step 4 needed a JS twin of those SQL clauses — `isSageVisibleForSearch`
(`packages/sage/src/retrieval/visibility.ts`). `getSage` is a raw primary-key read: it
knows nothing about status filters, audience scoping, `contextPolicy: 'never'` or session
ownership, so without that re-check the semantic channel would have been a hole in session
isolation.

Step 4 is also one round-trip per admitted hit, so the fusion gained a
`maxMaterializations` bound (default 12). The vector channel fetches `max(limit·2, 50)`
candidates; an unbounded fan-out would have put ~50 concurrent requests on the daemon's
single event loop for one search.

The vector store cannot simply move into the daemon: it owns an ONNX provider and
`@wrongstack/vector-memory` already depends on `@wrongstack/sage`, so wiring it the other
way is a dependency cycle.

### 4.2 The standalone WebUI never wired the vector store at all — High

`start-webui.ts` called `startFirstBootSageSync` and stopped there. It never called
`wrapMemoryPortWithVectorRecall` and never called `subscribeVectorMemoryToSage`. So the
WebUI mirrored the corpus once at first boot, never read it back, and never mirrored a
single write that followed. **Fixed**: both are now wired, with the mirror disposed before
the store closes in `start-webui-shutdown.ts`.

### 4.3 The lexical channel required every term of a synthetic query — High

Channel 2 called `searchSage(..., { requireAllTerms: true })`. Its query is
`enrichPathQuery`'s output — the full path plus basename, stem and parent directory:

```
packages/sage/src/retrieval/format.ts format.ts format retrieval
```

FTS5 expands that into six ANDed prefix terms, so a memory only matched if its text
literally quoted the whole path. The channel returned nothing on almost every tool call and
path anchors were doing all the work alone.

**Fixed** by removing the flag so the any-term retry can run. Precision is unaffected: it
comes from the 0.85 relation floor downstream (§2), not from the MATCH.

### 4.4 Vector search materialized the whole corpus to return ten hits — High (perf)

`VectorMemoryStore.search` selected `text`, `summary`, `metadata` and `tags` for **every**
row, then ran `rowToEntry` (a two-`JSON.parse` decode) on everything above the threshold —
which, at the default `threshold: 0`, is every row. On a mirrored SAGE corpus those columns
are the entire memory text.

**Fixed** with a two-phase scan: phase 1 reads `(id, vector)` only and keeps a bounded
top-k by insertion; phase 2 hydrates just the survivors in one statement. Cosine ranking is
still exhaustive (there is no ANN index) but the allocation and JSON cost is now
proportional to `limit`, not to corpus size.

### 4.5 Write-time dedupe could not see the duplicate — Medium

`findNearDuplicate` scanned the 64 **highest-importance** rows in the scope — a signal with
nothing to do with the text being written. A paraphrase of an ordinary 0.5-importance
memory was invisible to dedupe on any project with more than 64 memories in scope, which is
exactly the corpus size where duplicates start to hurt.

**Fixed** by unioning that window with an FTS-seeded one: the 32 rows bm25 ranks closest to
the incoming text. `isNearDuplicateMemory` still makes the call; this only decides which
rows it gets to see. Degrades to the old behaviour when FTS5 is unavailable.

### 4.6 A second, hand-inlined copy of the embedding math — Medium

`hybrid-rerank.ts` carried its own FNV-1a + log1p + L2 implementation, byte-duplicating
`HashingEmbeddingProvider` (the two had already drifted in their tokenizer comments), and
re-embedded every candidate's text on every search.

**Fixed**: `HashingEmbeddingProvider` gained `embedSync` (the contract is async only to
accommodate HTTP/ONNX backends; the hashing path has no I/O), the duplicate was deleted,
and results are memoized in a 512-entry FIFO cache — re-ranking runs against a largely
stable working set of memories within a session.

### 4.7 The gate killed every semantic hit anyway — Critical

Fixing the transport (§4.1) restored the *search*, not the *injection*. Both injection
surfaces gate on `memoryQueryRelevance`, which scores a semantic-only hit 0. So the
repaired vector channel returned the memory and the very next line threw it away:

```ts
if (relationStrength < relationFloor) { /* rejected */ }   // 0 < 0.85, always
```

A working semantic channel produced exactly zero additional injections. Worse, this failure
is invisible in the same way §4.1 was — the trace shows a `belowScore` rejection, which is
what a genuinely irrelevant memory also shows.

**Fixed** by `memorySemanticRelevance` (§2) plus routing both surfaces through
`searchSageWithBreakdown` when the port implements it. The flat `searchSage` shape discards
`vectorScore`, so without the breakdown there is no evidence to score. Both surfaces fall
back to the flat call — and to lexical-only behaviour — when the port has no breakdown.

The evidence string is deliberately `query:semantic-cosine:0.82` and not `semantic:…`:
`selectDiverseMemories` caps channel contribution by reason prefix, and a bare `semantic:`
prefix matches none of `anchor:` / `graph:` / `query:`, so it would slip past every
diversity cap.

### 4.8 `/memory race` raced the fused result against its own input — Medium

The race command built its "lexical" channel from `Sage.searchSage`, which is the
vector-*wrapped* surface in any host with a vector store. It was therefore comparing the
fused output against one of the two things that produced it, and reported a near-perfect
agreement ratio regardless of how the channels actually behaved — while the tuning notes in
this document point operators at exactly that number.

**Fixed** by recovering the true lexical channel from the breakdown: the hits with a
non-null `lexicalScore`, ordered by it.

### 4.9 The mirror garbage-collector spun forever and nothing called it — High

`forgetStaleSageMirrors` is the safety net for bulk SAGE operations — hygiene's
archive/purge passes, `memory.cleared` — which emit one top-level event rather than a
`memory.deleted` per memory, so the live event mirror never sees them.

It walked the store like this:

```ts
for (let offset = 0; ; offset += 1000) {
  const page = store.list({ limit: 1000 });   // `list()` has no offset parameter
  …
  if (page.length < 1000) break;
}
```

`offset` was never passed to anything. Every iteration re-read the same first page, so on a
store with a full page of entries and nothing to remove — the healthy case — the exit
condition was unreachable and the sweep spun forever. It also had **no production caller**,
which is the only reason nobody hit the hang: stale rows simply accumulated forever
instead.

**Fixed** on three axes:

- `VectorMemoryStore.list` gained keyset pagination (`after: {updatedAt, id}`) and a
  `(updated_at, id)` DESC order. The id tiebreak matters: `updated_at` alone is not unique,
  so two entries written in the same millisecond could swap between calls and a paging
  caller would skip one. Keyset rather than `OFFSET` because **the sweep deletes as it
  walks** — under `OFFSET` every removal shifts the remaining rows left and the next page
  skips exactly as many entries as were removed.
- `sweepStaleSageMirrors` wraps it with a throttle recorded in a marker file *beside the
  vector database*, not in a process-local variable, so the CLI and the WebUI on the same
  project share one hourly budget instead of sweeping twice per session. The slot is
  claimed before the walk, not after, so a second host booting mid-sweep does not start a
  concurrent pass.
- Both hosts now call it, fire-and-forget, right after subscribing the live mirror.

A stale row is not a correctness hole — a semantic-only hit is resolved through `getSage`
and re-checked with `isSageVisibleForSearch`, which rejects an archived or deleted memory
(§4.1's visibility twin doubles as staleness protection). It is a cost: every stale row is
scanned on every cosine pass and can consume one of the bounded `maxMaterializations` slots
before being dropped.

### 4.10 No configuration surface for any of it — Medium

Vector weight was the literal `0.3` in two host files; there was no way to disable the
store, raise the semantic-only floor, or bound the fan-out. **Fixed**: `Sage.vector`
(`enabled`, `weight`, `threshold`, `vectorOnlyThreshold`, `maxMaterializations`), read by
both hosts.

---

## 5. Configuration reference

```jsonc
{
  "Sage": {
    "inject": {
      "toolResults": true,      // default
      "turnContext": false,     // opt-in
      "maxHintsPerTool": 8,
      "maxCharsPerTool": 2800,
      "minScore": 0.72,
      "minImportance": 0.5,
      "relationFloor": 0.85,    // the real gate — see §2
      "repeatCooldownMs": 0     // 0 = once per session
    },
    "vector": {
      "enabled": true,
      "weight": 0.3,               // semantic share of the RRF blend
      "threshold": undefined,      // floor passed to the vector backend
      "vectorOnlyThreshold": 0.62, // floor for a lexically-missed hit
      "maxMaterializations": 12    // by-id round-trips per search
    }
  }
}
```

### Tuning notes

- `relationFloor` is far more powerful than `minScore`. Lowering it to ~0.8 admits
  single-anchor and two-tag matches; that roughly doubles channel-2 recall and is the first
  dial to try if injection feels too sparse.
- `vectorOnlyThreshold` governs the genuinely new capability: memories the lexical index
  cannot reach (paraphrases, synonyms, cross-file concepts). 0.62 is conservative for
  MiniLM-class models. Use `/memory race` for evidence before moving it.
- `turnContext: true` is the only way memory reaches context on a turn with no tool call.
  It costs one system block per turn and is gated at `relevance >= 0.62`.

---

## 6. Invariants

1. **The daemon is the sole owner of SQLite.** Hosts hold IPC ports. Never open a second
   writable store.
2. **Nothing function-shaped may cross the IPC boundary.** Options are `JSON.stringify`d;
   a function becomes `{}` and fails *silently* because every fusion path is fail-open.
   This is what §4.1 was.
3. **Any by-id read that feeds a result set must re-apply `isSageVisibleForSearch`.**
   `getSage` enforces no visibility policy of its own.
4. **`recordUse` is the corpus's only quality signal.** Anything that breaks the
   `InjectionTracker` → `recordUse` loop makes hygiene archive good memories and keep bad
   ones. The shared tracker instance in `setupSage` is load-bearing: a tracker per
   middleware silently drops every cross-path use.
5. **Precision lives in the gate, not in the query.** Widening a MATCH is safe; lowering
   `relationFloor` is the change that actually alters what the model sees.
6. **A new recall channel needs a relation-strength mapping before it ships.** Recall that
   the gate cannot score is recall that never reaches the model — and it fails as a
   `belowScore` rejection, indistinguishable from a correctly-rejected irrelevant memory.
7. **Every retrieval reason must carry a channel prefix `selectDiverseMemories` knows**
   (`anchor:` / `graph:` / `query:`). An unrecognised prefix silently disables every
   diversity cap for that hit.

## 7. Regression guards

`packages/vector-memory/tests/vector-recall-survives-ipc.test.ts` puts a real
`JSON.stringify`/`parse` round-trip between the wrapper and a fake store, and the fake
throws if it receives a `vectorRecall` whose `search` did not survive. A unit test against
an in-process fake passes whether or not §4.1 is present — only a test that models the wire
has teeth.

The same file pins the diagnostic that was missing: at least one hit must report
`source !== 'lexical'`. A dead semantic channel and a healthy lexical-only store are
otherwise byte-identical in every output the system produces.

`packages/sage/tests/tool-call-memory.test.ts` and `turn-memory.test.ts` pin §4.7: a
cosine-0.82 hit with *zero* lexical overlap must clear the default floor, a cosine-0.55 hit
must not, and the evidence must carry a `query:` prefix.

`packages/vector-memory/tests/sage-event-mirror.test.ts` pins §4.9 by forcing a multi-page
walk (`pageSize: 5` over 12 rows) — the only shape that separates a correct keyset walk
from a re-read of page one. The clean-corpus case would have hung under the old code, and
the delete-as-you-walk case is what `OFFSET` gets wrong.

### Mirror coverage

| SAGE event | Mirror action |
|---|---|
| `memory.accepted` / `memory.recovered` | forget-then-remember (metadata-only changes reach the store) |
| `memory.updated` (status ≠ deleted) | forget-then-remember |
| `memory.deleted` | forget by `metadata.sageId` |
| hygiene archive/purge, `memory.cleared` | **no per-memory event** → `sweepStaleSageMirrors` |
| session-scoped memories | never mirrored (privacy parity with the first-boot sync) |
