# Chronicle SQLite Journal — Software Design Document

**Spec ID:** `chronicle-sqlite-journal-v1`
**Version:** `1.0.0-draft`
**Created:** 2026-07-28
**Status:** Implemented (2026-07-28) — phases 1-4 landed; legacy reader retained behind `WRONGSTACK_CHRONICLE_STORE=jsonl`
**Owner:** Core Chronicle maintainers

---

## 1. Overview

### 1.1 Problem

Every project daemon in WrongStack is meant to be the same shape: one detached
owner per project, reached only over IPC, with SQLite as the sole backing store.
That invariant is now enforced by
`packages/core/tests/architecture/project-daemon-boundary.test.ts`. Four of the
five subsystems satisfy it. Chronicle does not: its primary event stream is a
set of hash-chained JSONL partitions (`<day>.events.jsonl`,
`<day>.events.NNNNN.jsonl`), and only the derived rollups in `metrics.db` are
SQLite.

The file format is not merely unfashionable — it costs real work:

- **Every query is a full scan.** `ChronicleQueryEngine` opens each partition
  that overlaps the requested range and parses it line by line. The 20+ filter
  fields in `ChronicleQuery` are applied in JavaScript after parsing.
- **Summaries cannot be sampled.** `ChronicleSummary` is defined as derived from
  *all* matching events, never from the paginated page, so a query that returns
  50 rows still parses every matching event to produce token totals, p95
  durations and per-family counts.
- **Retention is file-granular.** Purging means deleting whole partitions, which
  is why a `ChronicleRetentionCheckpoint` exists at all: the chain has to stay
  verifiable across a truncated prefix.
- **The rollup reads the raw files.** `ChronicleMetricsStore` tracks per-partition
  byte offsets in `ingest_state`, so the JSONL layout is load-bearing for a
  second subsystem.

### 1.2 Goal

Move the authoritative event stream into SQLite owned by the Chronicle project
daemon, such that:

- the tamper-evident chain (`sequence`, `previousHash`, `hash`) is preserved
  **bit-for-bit** — no re-hashing, no re-canonicalization of historical events;
- `query`, `facet`, `facets` and the summary become indexed SQL rather than
  full-partition scans;
- retention becomes a row delete of whole day-chains;
- existing on-disk journals are migrated, not discarded — they are an audit
  record;
- `chronicle` can be removed from `KNOWN_NON_SQLITE` in the daemon boundary test.

### 1.3 Non-goals

- Changing `ChronicleEvent`, `CHRONICLE_SCHEMA_VERSION`, or the hash algorithm.
- Changing the IPC operation set or its wire shapes.
- Full-text search. `ChronicleQuery.text` keeps its current substring semantics;
  FTS5 is a follow-up, not part of v1.
- Merging `metrics.db` into the new database. The rollup is repointed, not moved.
- Cross-host replication, or any change to `ChronicleGraph`.
- Deleting the legacy `.jsonl` files. v1 stops writing them and leaves them in
  place; reclaiming that disk is a separate, explicitly-approved step.

### 1.4 Design principles

1. **The chain is the contract.** Anything that would recompute a stored `hash`
   is a defect, not an optimization.
2. **Store the payload verbatim, project the filters.** Indexed columns are a
   derived read path; the durable truth is the serialized event.
3. **One writer by construction.** The daemon already wins an endpoint election
   before opening storage; the schema may assume a single writer.
4. **Migration is verify-as-you-go.** A journal that fails verification must
   fail the migration loudly rather than land unverifiable rows.
5. **Reversible until cut over.** The legacy reader stays until the new path has
   been exercised; rollback is a config flag, not a restore.

---

## 2. Baseline and authority map

| Concern | Today | After |
|---|---|---|
| Durable events | `journal.ts` → `<day>.events[.NNNNN].jsonl` | `events` table in `chronicle.sqlite` |
| Chain scope | one chain per `<day>` family | one chain per `day` column value |
| Chain anchor | last line of the day's newest partition + `ChronicleRetentionCheckpoint` | the day's highest `sequence` + its `chain_checkpoint` row |
| Partition rotation | 100 MiB → `rotatedPath()` | none (SQLite owns file growth) |
| Query | `ChronicleQueryEngine` line scan + `partition-range-cache.ts` | SQL over indexed columns |
| Summary | JS aggregation over every matching event | same accumulator, fed from SQL candidates |
| Retention | delete partition files within a day, write checkpoint | `DELETE … WHERE day < ?` (whole chains; no new checkpoint) |
| Verification | `verifyPartitionFiles()` per family | per day, `ORDER BY sequence` |
| Rollup ingest | per-partition byte offsets in `ingest_state` | `sequence` watermark |
| Producer sink | `ChronicleJournal` (inline) / `ChronicleRemoteJournal` (IPC) | unchanged |

`file-observer.ts` watches the **project tree**, not the journal. It is not
affected and must not be touched by this migration.

---

## 3. Invariants that must survive

These are the parts that make this a migration rather than a format swap.

### 3.1 The hash input is not the stored line

`journal.ts` writes `JSON.stringify(event)` (V8 insertion order, includes
`hash`), while the hash itself is

```
hash = sha256(stableStringify(event without `hash`))
```

where `stableStringify` sorts keys and drops `undefined`-valued keys. The
on-disk line is therefore **not** the hash preimage; the preimage is re-derived
from the parsed object.

**Consequence for the schema:** storing a re-serialized payload is safe *for
verification* as long as verification re-derives the canonical form from the
parsed payload, exactly as `verifyPartitionFiles` does today. It is **not** safe
to treat the stored bytes as the preimage.

### 3.2 Chains are scoped to a day, not to the journal

This is the invariant most likely to be assumed away, so it is stated first.

`ChronicleJournal` is constructed per day — `identity.ts` yields
`<projectDir>/chronicle/<day>.events.jsonl`, and `project-access.ts` keeps one
instance per day in a `Map`. `initState()` resolves its anchor from
`collectPartitions(this.basePath)`, whose regex is anchored on that day's base
name, and from `retentionCheckpointPath(basePath)`, which is likewise
per-family. A journal opened on a new day therefore finds nothing and starts at
`{sequence: 0, hash: GENESIS_HASH}`.

**Consequence:** `sequence` restarts at 1 every day, and there are as many
chains as there are day files. A single global `sequence` would require
re-chaining — that is, recomputing every historical `hash` — which §1.4.1
forbids outright.

Within one day: `sequence` is dense and monotonic from 1, `previousHash` of
event *n* equals `hash` of event *n−1*, anchored at `GENESIS_HASH` (64 zeros).
Batched appends compute the chain in memory from a single anchor per day and
must remain atomic: a partially applied batch leaves a hole. A batch that
straddles midnight extends two chains.

### 3.3 Retention removes whole chains, never a hole

The JSONL journal purges at file granularity within a day family and records
`{sequence, hash}` of the last removed event in a per-family
`*.retention.json`, so a partially purged day stays verifiable from that
checkpoint rather than from genesis.

Day-granular retention in SQLite is simpler: dropping `day < cutoff` removes
those chains in their entirety, leaving no dangling suffix to anchor. The
checkpoint table is still required, because a legacy day family that was
partially purged before migration arrives with a checkpoint that must be
carried over. A retention implementation that deletes from the middle of a
surviving day breaks verification permanently.

### 3.4 Append must survive partial failure

Today a failed `appendFile` sets `stateInitialized = false` so the next batch
rebuilds its anchor from disk rather than trusting in-memory counters. The
SQLite writer gets this for free from transaction rollback, but the anchor cache
must still be invalidated on error.

---

## 4. Target schema

Database: `chronicle.sqlite`, in the same directory as today's journal
(`<projectDir>/chronicle/`). Opened only by
`packages/core/src/chronicle/project-server.ts`, after the endpoint election —
the same ordering the mailbox owner uses and the boundary test asserts.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  day           TEXT    NOT NULL,      -- YYYY-MM-DD of occurred_at; chain scope
  sequence      INTEGER NOT NULL,      -- dense from 1 WITHIN the day
  event_id      TEXT    NOT NULL UNIQUE,
  hash          TEXT    NOT NULL,
  previous_hash TEXT    NOT NULL,

  -- projected filter columns (all derived from payload; never authoritative)
  occurred_at   TEXT    NOT NULL,
  event_type    TEXT    NOT NULL,
  outcome       TEXT,
  family        TEXT,                  -- ChronicleSignalFamily, for summary rollups
  project_id    TEXT,
  session_id    TEXT,
  agent_id      TEXT,
  task_id       TEXT,
  trace_id      TEXT,
  logical_request_id TEXT,
  attempt_id    TEXT,
  tool_call_id  TEXT,
  provider_id   TEXT,
  model_id      TEXT,
  resource_kind TEXT,
  resource_id   TEXT,
  resource_path TEXT,
  duration_ns   TEXT,

  payload       TEXT    NOT NULL,      -- JSON.stringify(ChronicleEvent), verbatim
  PRIMARY KEY (day, sequence)          -- the chain identity
);

CREATE INDEX IF NOT EXISTS events_occurred_at    ON events(occurred_at);
CREATE INDEX IF NOT EXISTS events_type_outcome   ON events(event_type, outcome);
CREATE INDEX IF NOT EXISTS events_session        ON events(session_id, day, sequence);
CREATE INDEX IF NOT EXISTS events_trace          ON events(trace_id);
CREATE INDEX IF NOT EXISTS events_logical_request ON events(logical_request_id);
CREATE INDEX IF NOT EXISTS events_resource_path  ON events(resource_path);
CREATE INDEX IF NOT EXISTS events_family_day     ON events(family, day);

-- Anchor for a day whose prefix was purged before migration: one row per day.
CREATE TABLE IF NOT EXISTS chain_checkpoint (
  day      TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  hash     TEXT    NOT NULL
);

-- Legacy import marker, mirroring the kanban migration convention.
CREATE TABLE IF NOT EXISTS chronicle_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`tags` and `attributes` stay inside `payload` and are filtered with SQLite's
JSON1 (`json_extract(payload, '$.tags.foo')`). They are sparse and
caller-defined; projecting them into columns would be a schema treadmill. If a
specific tag becomes hot, add an expression index rather than a column.

`schema_version` is tracked with `PRAGMA user_version`, matching
`metrics-store.ts`.

---

## 5. Write path

`append(inputs)` becomes one transaction:

1. `BEGIN IMMEDIATE`.
2. For each event, derive its `day` from `occurredAt`, then read that day's
   anchor: cached `{sequence, hash}`, or
   `SELECT sequence, hash FROM events WHERE day = ? ORDER BY sequence DESC LIMIT 1`,
   or that day's `chain_checkpoint` row, or `{0, GENESIS_HASH}` — the same
   precedence `journal.ts` uses today, applied per day.
3. For each input, stamp `observedAt`/`persistedAt`/`sequence`/`previousHash`,
   compute `hash`, and insert.
4. `COMMIT`, then update the cached anchor.

On any error: roll back, invalidate the cached anchor (§3.4), reject the batch.
Because the daemon is the only writer, `BEGIN IMMEDIATE` is sufficient; no
cross-process lock is required — which is exactly the property the per-project
daemon invariant buys.

Batching and the existing counters (`acceptedEvents`, `persistedEvents`,
`batches`, `largestBatch`, …) are preserved; `partitionRolls` becomes
permanently `0` and is retained in `ChronicleJournalStats` for wire
compatibility.

---

## 6. Read path

`ChronicleQueryEngine` gains a SQLite counterpart, `ChronicleSqliteQueryEngine`.

**SQL narrows; JavaScript decides.** The pushed-down `WHERE` is deliberately a
*superset* of the query: only predicates that map cleanly onto an indexed column
are translated, and every candidate row is then parsed and passed through the
JSONL engine's own `matches()`. Re-expressing `ChronicleQuery` in SQL would mean
restating tag and attribute lookups, path normalisation and line-range
containment — each a place the two engines could silently disagree. With this
split they cannot disagree about *which* events match, only about how quickly
candidates are found. Adding a predicate to the push-down list is an
optimization; omitting one is never a correctness bug.

Pushed down today: `eventId`, `projectId`, `sessionId`, `agentId`, `taskId`,
`traceId`, `logicalRequestId`, `resourceKind`, `resourceId`, `eventTypes`,
`outcomes`, and the `from`/`to` range against `occurred_at` (ISO-8601 UTC, so
lexicographic order is chronological — the same assumption `matches()` makes).

Left to `matches()`: `providerId`, `modelId`, `attemptId`, `toolCallId`, `path`,
`line`, `tags`, `attributes`, `text`.

**The summary reuses the accumulator, it is not re-derived in SQL.** Family
classification, nested `usage.*` paths, cost de-duplication by scope and the p95
over every matching duration are semantics rather than arithmetic; a second
implementation would drift into quietly different numbers rather than an error.
`createSummaryAccumulator` / `updateSummary` / `finalizeSummary` are exported
from `query.ts` and fed the parsed candidates. This keeps the summary exact at
the cost of iterating matches in JavaScript — the win still comes from indexed
narrowing rather than parsing every line of every partition. Pushing aggregates
into SQL is a later optimization, and the parity tests in §11 are what will make
it safe to attempt.

`graph()` moves across unchanged: `relationKeys()` defines the edges and
`compareEvents` orders the nodes, with each hop another ordered pass. Scan order
is load-bearing rather than cosmetic — both `maxNodes` truncations stop at
whatever they reach first, so a differently ordered candidate stream returns a
different subgraph rather than the same one shuffled. `ORDER BY day, sequence`
reproduces `comparePartitionPaths` (family, then rotation index) followed by
line order within a partition.

**Pagination** is keyset on `(day, sequence)`. Cursors are engine-scoped and not
interchangeable with the JSONL engine's file-snapshot cursor; both are opaque,
so this is a contract-preserving difference.

`scannedEvents`, `sourceFiles` and `invalidLines` remain in
`ChronicleQueryResult` for wire compatibility: `sourceFiles` reports `1`,
`invalidLines` counts unparseable payloads, and `scannedEvents` counts candidate
rows examined. `partition-range-cache.ts` becomes dead code and is deleted with
the legacy reader in phase 4.

`facet` / `facets` are **not** a SQL `GROUP BY`. `facetValue()` projects fields
that live inside the payload — `providerId`, `modelId`, `resourcePath`,
`toolCallId` — so grouping in SQL would only cover the few that happen to be
columns and would need a second, divergent definition for the rest. SQL narrows
the candidate set; the counting and the `count desc, value asc` ordering reuse
the JSONL engine's own projection and comparator. The tie-break matters: equal
counts are common, and without it the two engines order them differently.

---

## 7. Retention and verification

**Purge.** `DELETE FROM events WHERE day < :cutoff` plus
`DELETE FROM chain_checkpoint WHERE day < :cutoff`, in one transaction. No new
checkpoint is written: whole chains are removed, so nothing survives that would
need an anchor. `dryRun` runs the matching `SELECT COUNT(*)`. The current
result shape (`would delete N files`) changes to an event count; the CLI text in
`packages/cli/src/subcommands/handlers/chronicle.ts` and its test are updated
together.

**Verify.** For each `day`, walk
`SELECT sequence, hash, previous_hash, payload FROM events WHERE day = ? ORDER BY sequence`,
starting from that day's `chain_checkpoint` (or `GENESIS_HASH`), and for each
row assert:

- `sequence` is exactly `previous + 1` (dense, no holes);
- `previous_hash` equals the previous row's `hash`;
- `sha256(stableStringify(JSON.parse(payload) minus hash))` equals `hash`.

The third check is what makes this tamper-evident rather than merely ordered,
and it is why `payload` is stored rather than reconstructed from columns.

---

## 8. Migration from JSONL

Runs once, inside the daemon, before it starts serving:

1. If `chronicle_meta` has `legacy-jsonl-v1 = done`, skip.
2. Collect partitions with the existing `collectPartitions` / `comparePartitionPaths`
   ordering so numbered rotations follow their day file.
3. Group partitions by day family. For each family, read its
   `ChronicleRetentionCheckpoint`, if any, seed that day's anchor from it, and
   carry it into `chain_checkpoint`.
4. Stream every line of the family, in order, and for each event:
   - verify it against that day's running anchor (§7);
   - insert it with `sequence`, `hash`, `previous_hash` **taken from the file**,
     never recomputed;
   - project the filter columns.
5. Write the checkpoint row, mark `legacy-jsonl-v1 = done`, commit.

Failure handling: a verification failure aborts the whole migration in a single
rolled-back transaction and the daemon refuses to start with the offending
sequence number. A corrupt audit chain is a condition to surface, not to repair
silently — the operator can move the bad partition aside and re-run knowingly.

The `.jsonl` files are left untouched. Reads come from SQLite the moment the
marker is set.

---

## 9. Rollup repoint

`ChronicleMetricsStore` currently resumes from per-partition byte offsets. After
migration it resumes from a single `sequence` watermark and ingests
`SELECT … FROM events WHERE sequence > :watermark ORDER BY sequence`.

`ingest_state` gains a `sequence` column; the legacy `file`/`bytes` rows are
dropped by the existing `PRAGMA user_version` bump path. Because both databases
live in the same directory and are written by the same daemon, the read is a
plain attached query — no IPC hop.

---

## 10. Rollout

| Phase | Content | Exit criterion |
|---|---|---|
| 1 | Schema + writer + `verifyChain`, behind `WRONGSTACK_CHRONICLE_STORE=sqlite` | new-store unit tests green; chain verify passes on synthetic data |
| 2 | Migration importer | round-trip test: JSONL fixture → SQLite → `verify()` ok, event-for-event identical |
| 3 | SQLite query/facet/summary + purge | golden tests assert identical `ChronicleQueryResult` from both engines on one fixture |
| 4 | Flip the default (**done**), keep the legacy reader behind `WRONGSTACK_CHRONICLE_STORE=jsonl`. `metrics-store` repoint and deleting `partition-range-cache.ts` remain — neither blocks the invariant. | boundary test green with `chronicle` removed from `KNOWN_NON_SQLITE` ✅ |

**Rollback.** Phases 1–3 are behind the env flag; the legacy path is untouched
and reverting is a flag flip. After phase 4 the legacy reader is gone, so
rollback means reverting the release — which is why phase 3's golden tests are
the gate, not a nice-to-have.

---

## 11. Testing

- **Chain preservation** — the load-bearing test: import a fixture journal, then
  assert every `(sequence, hash, previousHash)` triple is byte-identical to the
  file, and that `verify()` returns `ok: true`. This must fail if any code path
  recomputes a hash.
- **Truncated prefix** — purge, then verify; assert verification starts from the
  checkpoint and still succeeds.
- **Tamper detection** — mutate one `payload` in place; assert `verify()` returns
  `ok: false` with the right `brokenAt`.
- **Batch atomicity** — force a mid-batch failure; assert no partial sequence
  range landed and the next append rebuilds the anchor from the database.
- **Query parity** — one fixture, both engines, identical `ChronicleQueryResult`
  including `summary` and cursor behaviour across pages.
- **Corrupt-import refusal** — a fixture with a broken link must abort migration
  and leave the database empty.

---

## 12. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| A refactor recomputes historical hashes | Silently destroys tamper evidence; the data still "looks fine" | Chain-preservation test (§11); `hash`/`previous_hash` are never derived on the write path for imported rows |
| Column projection drifts from payload | Queries return rows the payload contradicts | Payload is authoritative; a projection test asserts every indexed column is re-derivable from `payload` |
| `text` filter regresses to a table scan | Large journals get slower, not faster | `text` is always applied after the indexed predicates; FTS5 tracked as follow-up |
| Purge deletes a non-prefix | Verification breaks permanently, unrecoverably | Purge is `day < cutoff` only, and the retention test asserts the surviving set is a contiguous suffix |
| Migration on a multi-GB journal blocks startup | Daemon appears hung | Import in bounded transactions with progress on the `ping` health payload; document a one-shot `wstack chronicle migrate` |
