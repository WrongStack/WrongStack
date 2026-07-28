# SAGE Search & Suggest — Design Eval

> Status: **design-stage evaluation, not yet built.** This doc is the result of a 2026-07-28 design conversation about three things at once: (a) external consumers need a clean search/filter surface; (b) when search returns nothing close, we should offer suggestion memory; (c) the existing five retrieval primitives are overlapping and unfocused for an external agent.
>
> Read this *before* writing the code. The doc is the contract; the code is the implementation. If you disagree with a decision here, change the doc first, then the code matches.

## 1. Why this doc exists

There are three separate facts that, taken together, mean the current retrieval surface is the wrong shape for what the system is asked to do now.

**Fact 1 — external agents are stateless.** A consumer outside the WrongStack runtime gets a tool surface (the `wstack-sage-mcp` MCP server we already shipped). It calls one or two tools, gets text back, and makes decisions in a single call window. There is no "would you like to refine that query" — by the time the response has been read, the agent has moved on. **The design has to make search work in one or two calls, not five.**

**Fact 2 — search needs *ranking*, not just *hits*.** A human in a TUI can read a list and pick. An external code agent needs the system to do the picking — and explain what it picked so the agent can decide whether to trust the result. Today only the internal scorer (`MemoryInjectAgent`, in `packages/sage/src/middleware/`) emits scores; the typed service surface doesn't.

**Fact 3 — there is no "did you mean..." UX today.** When a user types "xcode16 build cache" and gets zero hits, we return zero hits. Most search systems mitigate this with *suggestions* — adjacents by topic, kind, or recently-anchored neighbors. SAGE has all the infra for this (anchor graph, kind tags, audience), but no caller-facing surface.

Three plausible interpretations of "topic-based suggestion memory" (sorted by cost/benefit):

- **A. Topic-as-cluster** — periodic clustering pass, returns cluster nearest the query. Heavy; needs indexing + jobs.
- **B. Topic-as-keyword** — derive keywords from the query, return memories tagged with those keywords. Cheap; falls over on paraphrase.
- **C. Topic-as-graph** — use the existing `memory_graph` and the user's recent-memory neighborhood to suggest adjacents when search is empty. **Free-rides existing infra. Better than B for agents with memory-of-memory.** This doc specifies **C** as the v1 design; A and B are deferred.

## 2. The shape we want (one call)

A single unified search that bundles: query, filters, ranking, limit, suggest-on-empty, cursor, audience. **One call → ranked rows + optional suggestions**.

```
search(query: SearchQuery, opts: SearchOptions) -> SearchResult
```

Where:

```
SearchQuery:
  text?: string                          // free-text query (optional; path-only searches allowed)
  paths?: string[]                       // path-prefix anchors
  kinds?: SageKind[]                     // filter by kind
  scopes?: SageScope[]                  // filter by scope (project / user / session / file / symbol)
  importanceAtLeast?: number            // 0..1
  freshness?: { verifiedAfter?: ISODate, createdAfter?: ISODate }
  audience?: { roles?: string[], taskTypes?: string[], modes?: string[] }
  anchor?: { type: AnchorType, path?: string, symbol?: string,
             command?: string, role?: string }
  cursor?: { memoryId: string, direction: 'before' | 'after' }

SearchOptions:
  limit?: number              // default 10, max 100
  includeStatuses?: SageStatus[]  // default ['active']
  ranking?: 'relevance' | 'recency' | 'importance' | 'hybrid'  // default 'hybrid'
  suggest?: 'never' | 'empty' | 'always'  // see §4. default 'empty'
```

And the response:

```
SearchResult:
  hits: SearchHit[]             // length <= limit; ranked per `ranking`
  suggestions: SearchHit[]      // populated iff suggest='always' OR (suggest='empty' AND hits is empty)
  totalCandidates: number       // so callers can show "showing 10 of 247"
  rankingApplied: 'hybrid' | 'relevance' | 'recency' | 'importance'
  queryEcho: SearchQuery        // optional, for debugging

SearchHit:
  id, kind, scope, tags: string[]
  anchors: MemoryAnchor[]
  audience?: MemoryAudienceSelector
  text: string                  // may be truncated above max_chars
  importance: number, confidence: number
  status: SageStatus
  createdAt: ISODate, updatedAt: ISODate, verifiedAt?: ISODate
  score: number                // 0..1, in the ranking scale
  matchReason: 'lexical' | 'tag' | 'anchor:file:src/foo' | 'graph:depth2:tag=auth'
                | 'audience:reviewer' | 'kind:bug_root_cause' | 'recency'
```

Three properties of this shape that matter for external agents:

- **Deterministic, parseable.** A code agent gets a typed-array shape with stable field names. No "natural language string" — that's a human UX, not an API.
- **`score` and `matchReason` are first-class.** A reasoning agent uses these to decide whether to trust the result. Without them, search is opaque.
- **`suggestions` is a top-level field.** Not nested under `meta` or `debug`. Default behavior keeps it empty; agents can flip `suggest: 'always'` when they're in discovery mode.

## 3. What this replaces in the existing surface

Today the typed service exposes *five* retrieval primitives (`packages/sage/src/service-contract.ts:72-115`). Each does one thing well; none is general. The new `search` does not replace them all — it replaces the *caller default* for "I want relevant memory for X" — and the existing primitives continue to exist for callers that need their specialized shape.

| Today | Behavior | Replaced by `search`? |
|---|---|---|
| `memory_search` MCP tool | lexical + tag, no filters | Yes — `searchSage` covers the same ground with filters |
| `memory_for_path` MCP tool | path-anchored recall, no filters | **No** — kept; `search` can include path-prefix as a filter but `memory_for_path` returns the three-bucket shape external agents use |
| `memory_for_file` MCP tool | cursor-aware file/symbol neighborhood | **No** — kept; the cursor-awareness (line range → strength boost) is a different ergonomics |
| `memory_graph` MCP tool | graph traversal from a seed | **No** — kept; `search` does *not* traverse. `memory_graph` is its own primitive. |
| `findRelatedSage` | hydrate one row's neighbors | **No** — kept |
| (the new `search`) | — | **this doc** |

**Important rule:** `search` does not delete any existing op. The existing five stay; the new `search` is *additive* and becomes the default for "give me relevant memory, ranked."

## 4. The suggest-on-empty contract in detail

Three states matter:

1. **suggest='never'** — the response never contains a `suggestions` field (it's omitted entirely). Strict callers.
2. **suggest='empty'** (default) — `suggestions` is populated **only** when the result set is empty. This is the polite-default behavior: you got *something* back, and adjacents would just be noise. You asked for nothing → we suggest.
3. **suggest='always'** — `suggestions` is populated whenever there is anything in the corpus that ranks above threshold for the *graph neighborhood* of the query, *even if the result set is non-empty*. Discovery mode.

`suggestions` is *always* sorted by the same `ranking` policy as `hits`, with one bonus: graph-distance from the query's nearest semantic neighbor enters the ranking. **No separate ranking for suggestions** — that would be a surface that callers cannot reason about.

What `suggestions` is *not*: it is not a "did you mean..." spelling fix. It is not a paraphrase expansion. It is not "things that are vaguely related to your topic." It is **memory that has graph proximity to your query's semantic nearest neighbor**, gated by the same ranking threshold as `hits`.

What this means for determinism: an autonomous agent seeing `suggestions` can interpret them as "the system thinks these are adjacent to what you asked about" — and the `matchReason` on each suggestion will say `graph:depth2:tag=auth` or similar, so the agent can confirm the source of the suggestion.

## 5. Where the ranking signals come from

Today the internal scorer (`packages/sage/src/middleware/tool-call-memory.ts`) computes `ScoredEntry[]` from a `MemoryRelevanceContext`. The shape leaks into the runtime's recall pipeline but *not* into the typed service surface. **The new `search` op means implementing the same scorer publicly**, in three layers:

1. **Lexical match** — tokenize, FTS5 lookup (`packages/sage/src/sqlite-store.ts` already has the FTS5 path).
2. **Tag match** — exact-match bonus on a tag.
3. **Anchor match** — path-prefix or symbol match boost, weighted by `anchors[].strength`.
4. **Audience match** — boost if the query's audience selector overlaps the memory's.
5. **Kind filter** — hard filter, not a boost. `kinds=['bug_root_cause']` excludes everything else.
6. **Recency boost** — small additive; only active when `ranking ∈ {'recency','hybrid'}`.
7. **Graph adjacency** — for `suggestions`, `BFS depth≤2 from the lexical-nearest hit`, then ranked the same way.

All scoring surfaces through one method on the service object. **No policy baked into the SQL query.** SQL handles correctness (filter); the scorer handles ranking.

## 6. Defaults that keep external agents from overfitting to one strategy

A non-obvious risk: if `search` always defaults to `ranking='hybrid'`, external agents will train against it (their prompts and heuristics will assume it). Three rules:

1. The default ranking *is* `'hybrid'`. Document it; treat that as the contract.
2. `score` is always in the same range (0..1, computed the same way). The agent can pick a `>=0.5` threshold and trust it across queries.
3. `matchReason` strings are a *closed enum*. The agent does not have to parse free-text. Any new match reason is a breaking change to be versioned.

These rules bind *us* (the implementation) more than they bind external agents. Important.

## 7. Audience scoping — interaction with the new `search`

Today `retrieveForAudience` exists as a separate retriever. With `search`, audience becomes an input filter:

- If the caller passes `query.audience`, only memories tagged with that audience are returned.
- If the caller passes nothing, **all** relevant memories are returned regardless of audience. **Mnemosyne is the global memory; audience is a tier, not a boundary** — an agent who passes `audience:['reviewer']` opts in to review-scoped memory, but absence of `audience` does not mean "pretend reviewer-scope memory doesn't exist." This is a *deliberate inversion* of what `retrieveForAudience` does. We're picking "search is a global view; audience is a filter the caller opts into," which is more useful for external agents than the inverted audit-scoped default.

## 8. Interaction with the MCP surface

When the new `search` op is implemented at the IPC level, the corresponding MCP tool gets added to `packages/sage-mcp/src/policy.ts`. **Default policy exposes it** (it's read-only). Schema mirrors the `SearchQuery` shape; the adapter translates `{ text, paths, kinds, ... }` 1:1.

Two MCP-specific details:

- **InputSchema for `search`** is the *most* complex schema exposed by the MCP server. It's also the schema most worth being precise about — because external agents are *string-parsing* AI systems that will reason imprecisely over nuanced schemas. **Use `enum: [...]` strings for `ranking`, `suggest`, `includeStatuses`, kind/scope values.** Use `minimum`/`maximum` for numeric bounds. Use `minLength: 1` on text. **Reject silently-bad input at the adapter boundary** (`src/adapter.ts:125-131` already does this for `memory_delete`'s `force:true`; the same pattern applies).
- **`suggestions` for human UIs.** The TUI's `/memory search` reuses the same MCP surface. The TUI defaults `suggest='always'` for human ergonomics; autonomous-mode agents leave `suggest='empty'`. Both are safe; the surface documents both.

## 9. What this design does NOT do

Deliberate non-goals:

- **No clustering / embedding-based similarity.** Embedding vectors would buy us true paraphrase matching; that's a real design of its own, with its own concerns (model selection, embedding store, drift, cost). Defer.
- **No fuzzy text search beyond what FTS5 already gives.** SQLite's FTS5 has tunable tokenizers; we use the default. If that's wrong for non-English corpora, fix FTS5, not the API.
- **No subscription / pubsub on search.** If the corpus updates while an agent holds a result, the result is *stale as soon as it returns*. We don't promise freshness beyond `updatedAt`. If you need live memory, listen on the `memory.*` event bus.
- **No ACID across many results.** `search` is a snapshot at one point in time. Multi-result consistency is *not* guaranteed.

## 10. How to apply this design (three additive commits)

Each step independently verifiable. None breaks any existing op.

**Naming clarification (caught during commit-1 protocol layer, 2026-07-28):** the legacy IPC op `'search'` (at `project-server-protocol.ts:80`) already exists with shape `{query: string, scope?, limit?}` returning `MemoryEntry[]`. To preserve that contract for any existing external code, **the new IPC op is named `unifiedSearch`** — same convention as Phase 1's `searchSage` (typed Sage shape) vs `search` (legacy `MemoryEntry` shape). The user-facing API in §2 ("the shape we want") keeps the `search(...)` shape at the public boundary; the IPC op's *protocol* name is `unifiedSearch`, but that detail is invisible to typed-service and MCP-tool callers.

1. **IPC op `unifiedSearch`**. Add `unifiedSearch` to `SageServerOperations` in `packages/sage/src/project-server-protocol.ts`; dispatcher case at `packages/sage/src/project-server.ts:197`; implement on `SqliteSageStore` (and through `ProjectSageMemoryPort`'s service capability). Includes lex+tag+anchor+audience+kind+recency scoring per §5; suggestions via lexical adjacency for v1, graph BFS deferred to v2.

2. **Typed service method**. Expose `unifiedSearchService(query, opts)` on `SageServiceLike`. Implementation lives in `packages/sage/src/sqlite-store-search.ts` (new file, named clearly). Pure function over FTS5 + the existing graph adjacency state. Pure means: same inputs → same outputs.

3. **MCP tool `search`**. Add to `createSageTools(service)` in `packages/sage/src/tools/memory-tools.ts`. Default riskTier `'safe'`, permission `'auto'`. Exposed by default — does not require `--writable`. **First round-trip for external agents.** Note: the MCP tool name *can* be `search` (the public-facing name) because there's no existing MCP tool with that name; the legacy `search` op is IPC-only and never reaches the MCP surface.

Plus a fourth — the documentation work the user asked for:

4. **Doc updates** to:
   - `packages/sage/docs/direct-icp-usage.md` (already linked in §9 of that doc)
   - `packages/sage-mcp/docs/tool-surface.md` (add `search` to the inventory table when commit 3 lands)
   - `packages/sage-mcp/docs/safety-contract.md` (note that `search` is read-only by default; no new safety surface)
   - `packages/sage/README.md` (already linked from `## For consumers`)

And — crucially — **tests**. The behavior of `search` is testable end-to-end: a fixed corpus, a fixed query, a fixed scoring expectation. Tests should pin the contract, not the implementation.

## 11. Open questions I'd ask *before* writing code

This doc is the design. The user might still steer the implementation:

- **Should `suggest='always'` be the default for human UIs?** I think yes; the user might disagree. Defaulting it off makes silent laziness — agents that "just keep reading" — measurably worse.
- **For `kind: ['bug_root_cause']`, should we surface anchor-graph adjacents more aggressively?** I'd weight these higher because they're the high-value memories external agents most often need.
- **Is the result `text` truncated?** If yes, where does the truncation point land? Front, back, middle?
- **Should `search` participate in the existing auto-audience containment?** I'd argue *no* — search is a global read; the audience field is *opt-in* on the call side. Make this explicit.

I'll wait for the user's signal before code.
