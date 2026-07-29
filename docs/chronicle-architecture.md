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
