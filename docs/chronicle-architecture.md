# Chronicle Data Ownership

Chronicle is one per-project telemetry pipeline. Event producers do not own storage, and
WebUI/CLI consumers do not read journal or metrics files directly.

```text
session EventBus
  -> Chronicle adapters
     normalize + correlate + scrub secrets + roll up noisy streams
  -> ChronicleRemoteJournal
     bounded batching + local IPC
  -> one project Chronicle server
     assign sequence/hash -> append to SQLite journal -> observe files once
     refresh metrics.db -> query/facet/graph
  -> project access API
     WebUI WS routes -> Coding Intelligence / File Activity
     CLI `wstack chronicle`
     review context provenance
```

The primary journal was migrated from daily JSONL partitions to SQLite
(`chronicle.sqlite` on disk, owned exclusively by the project server).
The legacy JSONL reader is retained behind `WRONGSTACK_CHRONICLE_STORE=jsonl`
for migration verification. The new SQLite store (`sqlite-journal.ts`,
`sqlite-query.ts`) provides indexed queries, row-level retention, and
efficient summarization — eliminating the full-partition scans that the
previous format required.

## Ownership contract

| Stage | Owner | Responsibility |
| --- | --- | --- |
| Collect | Session EventBus adapters | Convert provider, stream, tool, process, decision, domain, rollup, file and health signals to `ChronicleEventInput`; attach project/session/agent/task correlation; scrub secrets. |
| Ingest | Project Chronicle server | Be the only production writer; assign monotonic sequence and hash-chain fields; batch, flush, rotate daily partitions and enforce retention. |
| Observe | Project Chronicle server | Run one project file watcher and attribute external/editor mutations without starting one watcher per CLI/WebUI client. |
| Process | Project Chronicle server | Build disposable derived aggregates in `metrics.db`; answer query, facet and lineage graph operations over durable journal evidence. |
| Serve | Project access API | Expose one typed operation contract to CLI, WebUI-server and internal review consumers. |
| Present | WebUI and CLI | Render or print results only; never infer a separate Chronicle directory or open storage directly. |

## Physical state

The canonical project state directory comes from `resolveWstackPaths`, not from
`<workspace>/.wrongstack`.

- `chronicle/chronicle.sqlite` is the primary durable journal and tamper-evident hash chain.
- `chronicle/metrics.db` is a rebuildable projection of the journal.
- `chronicle/YYYY-MM-DD.events.jsonl` is the legacy JSONL format retained for migration
  compatibility behind `WRONGSTACK_CHRONICLE_STORE=jsonl`.
- The project-server endpoint metadata identifies the elected owner process and local IPC
  endpoint. It lives in the resolved project state, beside the Chronicle runtime state.

The SQLite journal is authoritative. Query caches and `metrics.db` are derived and may be
rebuilt from the journal. Row-level retention replaces file-granular partition management.

## Volume policy

Chronicle is the highest-volume writer in the runtime, so what it *declines* to store is
as much a part of its design as what it keeps. Four mechanisms, in the order an event
meets them:

1. **Collection allowlist** — `domain-adapter.ts` bridges only domains that can improve a
   coding decision, provenance, reliability or cost control. UI presence, navigation and
   other product-engagement events are never collected.
2. **Windowed aggregation** — `rollup-adapter.ts` turns high-frequency ephemeral signals
   (process output, progress ticks, context gauges, per-request network chatter, fleet
   snapshots) into one bounded aggregate per window instead of one row per sample.
   Resource observations are keyed on the logical request, so an agent turn produces one
   aggregate rather than one per tool call.
3. **Detail policy** — `detail-policy.ts` classifies each event as kept or foldable, and
   `counter-sink.ts` folds the foldable ones into periodic `metrics.counter` aggregates.
   It sits between every adapter and the journal, so the policy cannot drift per-adapter.
   Levels are `full`, `balanced` (the default) and `lean`, selected by `chronicle.detail`.
   A failure, denial or cancellation is never folded, at any level.
4. **Storage limits** — `chronicle.retentionDays` (age), `chronicle.maxEvents` (rows, with
   prefix eviction that checkpoints the chain so `verify()` still succeeds over the
   truncated prefix) and `chronicle.maxBytes` (aggregate SQLite allocation across the
   database and its WAL/SHM sidecars).

Two properties of the storage layer support all of the above:

- **`payload-codec.ts`** compresses the stored event JSON with a frozen deflate preset
  dictionary of the envelope skeleton and restores it byte for byte on read. The `payload`
  column remains the source of truth for hash verification; only its encoding changed, and
  pre-codec rows stay readable in the same table with no migration. Measured on a live
  4-day journal: 1518 B average down to 618 B (41%).
- **Incremental vacuum** (`ensureIncrementalVacuum`) lets a purge or a `maxEvents` trim
  hand pages back to the filesystem. Without it SQLite parks freed pages on the freelist
  and the file keeps its all-time high-water mark forever — measured on a live install as
  a 220 MB `metrics.db` holding 18 MB of live data. The pragma must be set *before*
  `journal_mode = WAL` and before the first `CREATE TABLE`, or SQLite accepts it and does
  nothing.

`metrics.db` splits its tables along the same line: per-event rows (`file_lineage`,
`logical_request_daily`) are pruned to `chronicle.metricsRowRetentionDays`, measured from
the newest recorded day rather than the wall clock, while every daily aggregate is kept for
the life of the file. That asymmetry is what lets the projection outlive the raw journal.

## Runtime and fallback

`createChronicleEventJournal` is the producer entry point.
`createChronicleProjectAccess` is the read/process/control entry point. These are the only
places that choose between the project server and inline recovery behavior.

Normal packaged runtime uses one lazily elected local project server. Concurrent CLI, TUI
and WebUI processes connect to that same owner. The owner stays alive while clients or
requests exist and exits after its idle grace period. Calls use bounded frames and producer
batching so a slow store cannot create an unbounded in-process event queue.

Source-only development, tests, or an explicitly disabled/unavailable server build use the
inline fallback. Inline mode preserves functionality but has no shared watcher and must be
shown as a degraded ownership mode to operators; callers still use the same access API.

## Operational visibility

WebUI clients request `chronicle.status`; CLI users run `wstack chronicle status`. The
response reports:

- `mode`: shared `server` or `inline` fallback;
- owner PID, uptime, connected clients and active requests;
- authoritative Chronicle directory and IPC endpoint;
- journal queue/rejection counters;
- project watcher state and watched-file count;
- the explicit collect -> process -> store -> serve pipeline.

The Coding Intelligence dashboard renders this ownership strip. This makes a query result
traceable to the same collector and processor that owns the underlying project evidence.

## Guardrail

`chronicle-ownership-boundary.test.ts` scans production TypeScript and rejects direct
construction of `ChronicleJournal`, `ChronicleQueryEngine` or `ChronicleMetricsStore`
outside `packages/core/src/chronicle`. New consumers must extend the typed project-server
operation contract instead of opening Chronicle files.
