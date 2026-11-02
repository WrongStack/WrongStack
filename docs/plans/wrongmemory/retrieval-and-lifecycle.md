# Retrieval, applicability, and memory lifecycle

Status: proposed behavior with current-SAGE compatibility as the initial profile.

## 1. Preserve the distinction between five signals

| Signal | Meaning | Does not establish |
|---|---|---|
| Source anchor verification | Referenced file/symbol/evidence can be checked now | Claim is correct for every branch/task |
| Validity checks | Specified literal source conditions are satisfied/unknown/not satisfied | All applicability assumptions hold |
| Confidence/importance/freshness | Attributed ranking/lifecycle metadata | Calibrated factual truth |
| Injection/use evidence | Record was rendered or later referenced | Task completed successfully |
| Explicit task outcome | Host observed a defined outcome with provenance | Universal usefulness of every recalled memory |

Do not implement a single "truth score" by multiplying these fields. Preserve evidence, scope, revision, and uncertainty so clients can reason about them.

## 2. Query modes

| Mode | Typical caller | Contract |
|---|---|---|
| Automatic recall | WrongStack tool/turn middleware | Strong eligibility/relation/cooldown/context-budget rules |
| Interactive memory search | External MCP or CLI | Bounded relevant hits with revision/provenance; no automatic use credit |
| Management discovery | WrongStack WebUI / optional WrongMemory GUI | Explicit status filters; session data hidden unless a trusted admin capability applies |
| Exact record lookup | Client resolving a previous ID | Same visibility as that caller; hidden and absent IDs indistinguishable |
| Review queue | Authorized proposer/curator | Candidate visibility and actions scoped separately from active memory |
| Explicit semantic search | User-facing diagnostics | Provider failure explicit; not a fabricated zero-hit answer |

Use one shared policy implementation. Do not infer caller authority from optional query flags. A legacy internal `includeAllSessions` argument becomes an administrative capability check at the service boundary.

## 3. Recall pipeline

1. Resolve authenticated principal, project, allowed namespace, actual workspace, session binding, and requested purpose.
2. Validate/normalize query, paths, kinds/scopes/tags/audience/status filters, limits, and cursor.
3. Apply eligibility policy before candidate selection/counting: project/session visibility, lifecycle, contextPolicy, requested management mode.
4. Retrieve lexical FTS/Unicode/path/tag/command/audience candidates under current SAGE semantics.
5. Optionally retrieve bounded semantic candidates from the matching provider/model/index revision.
6. Materialize semantic IDs from authoritative SAGE records and reapply every visibility/revision rule.
7. Expand eligible graph relations within depth/cycle/degree limits; hidden nodes are not traversal bridges into disclosed results.
8. Rank with the negotiated lexical/recency/importance/hybrid profile, deterministic tiebreaks, and channel explanations.
9. For automatic recall, apply relation floor, score/importance, diversity, already-visible exclusion, cooldown, and context budget.
10. Check bounded source applicability evidence where requested; attach results with observed revision/workspace/source hash.
11. Return explicit truncation/next-cursor/channel/provider/freshness metadata. Record rendering only through a separate acknowledged event.

When filters cannot be enforced before top-k/page selection, report them unsupported rather than filtering one retrieved page and claiming a complete total.

## 4. Automatic injection ownership

Initial split: WrongMemory supplies retrieval/evidence/lifecycle; WrongStack owns actual prompt/tool-result rendering, token budgets, active role/mode/task context, injection tracker, and request-time revalidation. This avoids replacing session behavior at the same time as storage.

The service can later offer a `recall.plan` operation returning eligible hints and trace reasons. It still cannot know that a model actually received a hint until a host reports rendering. A fetched but discarded candidate does not increment injectionCount.

Preserve current tool-result default and opt-in turn injection. Current defaults: relation floor 0.85, minimum score 0.72, importance 0.5. Budget/cooldown/diversity are host-configured and must be captured in M0. Threshold changes require evidence and a semantic profile update.

No double injection through both WrongStack's native memory adapter and an automatically configured WrongMemory MCP server. Native integration is the preferred path inside WrongStack; external MCP remains available only when deliberately enabled for another agent/tool surface.

## 5. Semantic recall

### 5.1 Authoritative record and derived cache

Do not put embeddings into canonical SAGE JSON or treat independently stored vectors as active memories. A service-owned derived semantic store contains project/store identity, memory ID, content revision/hash, provider/model ID, dimensions, preprocessing version, normalized vector, and build state.

Existing `@wrongstack/vector-memory` includes both SAGE mirrors and independent entries. Native migration imports only explicitly mapped SAGE mirrors into the corresponding memory cache; it does not absorb unrelated vector notes into SAGE without review. Keep the independent corpus intact and document who owns it.

The compatibility preview may retain host fusion. Once daemon fusion is enabled, the WrongStack wrapper must not fuse again. Capability negotiation selects exactly one fusion owner per request.

### 5.2 Provider options

- Lexical-only operation is always supported without model downloads or network access.
- Optional local native embedding runtime/model: select after license, tokenizer, MSRV, CPU/architecture, memory, and output-parity spikes.
- Optional external embedding endpoint: separately configured credentials, project data consent, request budgets, timeout, and privacy documentation.
- Existing host embeddings may be supplied as trusted scored IDs/vectors during preview, with provider/revision metadata; executable callbacks never cross IPC.

No ONNX/inference dependency or model is selected by this plan without a version/license/compatibility investigation. Semantic support is not blocked on installing an arbitrary heavyweight model.

### 5.3 Fusion and invalidation

Preserve current RRF behavior initially: bounded semantic-only materialization, current visibility gates, channel source labels, and configured weights. Current k=60, default vector weight 0.3, extra semantic candidates capped at 12, and baseline-only threshold 0.62 are fixture inputs, not universal model recommendations.

Semantic invalidation occurs after committed content/lifecycle/policy changes. Generation/revision tagging excludes stale vectors immediately, even if deletion/re-embedding is delayed. Tombstones and `contextPolicy=never` cannot leak through an old nearest-neighbor cache. Project/session filters are enforced before returned counts and candidate materialization.

For small project corpora, bounded exact cosine search is a reasonable first implementation. ANN is a later measured optimization requiring recall-equivalence tests and project partitioning. Do not add an external vector database to satisfy a local SQLite memory objective by default.

## 6. Graph and structural retrieval

Port node IDs, about_* edges, relationship weight max policy, command normalization/families, ancestor paths, audience matching, hub damping, and traversal ordering. Preserve add-only relationship assertions unless explicit retraction becomes a versioned new operation.

Bound traversal depth, visited nodes, returned edges, and query cost; handle cycles and dangling/corrupt neighbors without hiding valid siblings. Exact-ID/graph/count results cannot expose an unauthorized memory through an error distinction.

Rename remapping is evidence-based and revision-bound. A filesystem rename can establish path movement; a similar symbol name alone cannot prove the same semantic claim. Cross-worktree source evidence is labeled with its workspace and generation. Missing files on another branch become unknown/not-applicable evidence, not a forced global tombstone.

## 7. Validity evidence

Keep `MemoryValidity.statement` and up to four literal `source_contains` checks. No command execution, regex evaluation, dynamic imports, or project-defined verification scripts.

Evidence result carries memory ID, observed revision, workspace ID, checkedAt, path, literal, outcome, and optional source hash. Satisfied checks only prove the literal was observed. A timed-out/unreadable/missing authorized source records unknown according to the current contract; an absent literal records not_satisfied. Neither automatically means the memory is globally false.

Initial automatic evidence wait budget matches the current 250 ms policy, with hard file/byte/concurrency limits and cancellation. Cache by project/workspace/path evidence revision and memory revision; invalidate on source changes. A cached check from one checkout must never be presented as evidence from another.

## 8. Create/update/feedback

Create validates current input limits, durable-content guards, source claims, structural anchor requirements, metadata, audience, validity, and secret policy. Claimed user provenance supplied by an external model remains a claim unless an authenticated host/operator attributes it; do not let arbitrary `source.type=user` upgrade authority.

Update re-reads under writer ownership and enforces expected revision. Scope and owner session remain immutable through ordinary updates. Unknown extensions survive round-trip. Structural/content revisions are distinct from counter activity.

Feedback requires the revision actually observed, evidence, and a server-attributed principal/session. Preserve the existing bounded history and same-revision factual challenge semantics. Do not let an external client submit feedback for a hidden ID or forge another client's review identity. Feedback-only requests cannot bundle a lifecycle/content rewrite.

## 9. Candidate workflow

```text
proposed -> pending -> accepted (new/linked authoritative memory)
                    -> rejected (reason retained)
                    -> merged (explicit target and revision)
review proposal -> pending -> resolve action against still-matching targetRevision
```

Candidate fields preserve source/proposer identity, project/workspace, kind/scope/audience/validity, anchors, targetMemoryId, targetRevision, suggestedAction, reviewReason, and consolidation member revisions.

Read/propose clients can list authorized pending proposals and create candidates. They cannot accept their own proposal by switching an action field, mutate a target, request a session scope they do not own, or auto-promote by inflating confidence.

Accept/merge/resolve are server-authorized curator operations and transactional with canonical memory/edges. Stale target/member revisions return a conflict and require fresh review. Repeating acceptance with the same idempotency key returns the original outcome. Candidate import/reconciliation must not convert a corrupt candidate into an active memory.

## 10. Lifecycle transitions and deletion

Preserve active/stale/superseded/contradicted/archived/deleted states and distinguish verification-stale from manually stale/retired records. Successful structural re-verification may restore verification-stale records according to the baseline; it does not undo an operator retirement.

Ordinary delete requires a granted destructive action and the existing force/explicit review gate. It writes a tombstone with revision increase, dependency cleanup, and audit; `neverInject` remains orthogonal. Do not equate `forget` with a harmless search operation: export its actual legacy matching/deletion contract and keep it outside default MCP policy.

Recovery follows superseding chains with cycle/depth bounds, preserving identity/history semantics. Backfill remains dry-run by default, produces new active successors when appropriate, and avoids duplicate recovery of one knowledge item. Physical purge is a separate explicitly configured administrative operation with backups/retention evidence.

## 11. Hygiene and maintenance

Preserve the actual baseline behavior, including authorized automatic effects rather than incorrectly promising every pass is read-only:

| Area | Required behavior |
|---|---|
| Structural verification | Source/anchor checks; baseline freshness/status rules and manual-stale protection |
| Exact duplicates | Scope/session/kind/audience/validity-sensitive consolidation with in-transaction revalidation |
| Near duplicates/contradictions | Bounded analysis and review candidates; conditional claims kept separate |
| Permanent/critical records | Special safeguards; no statistical non-use shortcut to deletion |
| Session expiry | Baseline configured soft-delete/retention rules; default seven-day retention captured in fixtures |
| Explicit TTL | Preserve intended scope/persistence behavior; export exact baseline conditions before porting |
| Tombstone purge | Opt-in eligibility and revision/lifecycle recheck before physical removal |
| Review auto-accept | Preserve explicit policy/hold window/member revisions; default external proposals do not enable it |

Schedules persist per project; competing hosts negotiate one effective options revision. A later client must not silently weaken an operator's retention policy. Jobs run at low priority with checkpoints, deadlines, and explicit reports. An expired session can be garbage-collected without granting another client access to its contents.

## 12. Capture, consolidation, and Companion

WrongStack host capture stays event-driven and optional. External clients initially use explicit proposals with evidence; hooks may later submit bounded outcome/session summaries under separate grants. Raw private transcript import is a separately requested data operation.

LLM consolidation is opt-in, project-budgeted, and revision-bound. Reports distinguish generated suggestions from accepted memory. A model cannot approve its own destructive proposal by returning a particular JSON field. Any currently configured baseline auto-accept behavior is explicitly represented in policy and tested.

Memory Companion remains host-owned initially: read-only evidence review with scoped source access and current bounded execution rules. The daemon can serve evidence and retain attributed reports but does not run shell, delegate tasks, or treat another memory as proof. A report for an older revision/source hash is shown as stale, not as current verification.

## 13. Usage accounting and quality evaluation

Fetch/read, rendered injection, reference/use, explicit feedback, and task outcome are separate event types. Retry deduplication prevents counter inflation. Counters do not advance content recency or trigger HQ/FTS/re-embedding churn.

Generic MCP clients can truthfully report a tool call returned a memory. They usually cannot prove that it was later injected or materially used; do not fabricate WrongStack-equivalent telemetry. An optional `memory_usage` tool accepts bounded attributed events with clear self-reported provenance.

Evaluate retrieval with held-out tasks and hard negatives: correct project, correct session, applicable conditions, required fact recall, precision within context budget, stale evidence rate, and redundant tokens. Benchmark both lexical-only and optional semantic channels. A successful demo or model saying "useful" is not a corpus-wide quality certification.
