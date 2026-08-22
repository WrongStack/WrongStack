# Codebase Index Service

WrongStack runs one detached index server for each resolved local index
directory. TUI, CLI, WebUI, tool calls, and Code Atlas graph queries share that
process and its SQLite index.

## Lifecycle

- The IPC endpoint is deterministic: a Windows named pipe or a Unix-domain
  socket derived from the resolved index directory.
- The first client that cannot connect starts a detached server. Concurrent
  starters are elected by the operating system's exclusive socket bind; losing
  candidates exit.
- Clients disconnect independently. The server remains available for other
  clients, then exits after five idle minutes by default.
- `WRONGSTACK_INDEX_SERVER_IDLE_MS` changes the idle timeout.
- `WRONGSTACK_INDEX_INLINE=1` or `WRONGSTACK_INDEX_SERVER=0` disables the
  detached service and retains the worker/inline fallback.

## Transport

The default wire framing is newline-delimited JSON (NDJSON). The server also
speaks a binary framing — `[0x57][uint32 BE length][MessagePack payload]` —
read per frame by sniffing the first byte, never by a latched mode: the
reader accepts JSON and binary frames interleaved on the same socket, so a
JSON broadcast between binary responses cannot desynchronize it. The server
advertises the capability as `binarySupported` in its `hello` frame and
answers each request in the framing it arrived in; note that the server's
**outbound** framing latches to binary after the first binary request on a
connection (later JSON-framed requests still get binary responses) — the
per-frame sniffing applies to inbound traffic on both sides.

Client adoption is **opt-in** via `WRONGSTACK_INDEX_BINARY=1`. The default
stays NDJSON because the measured trade-off is poor: on a Windows named pipe
(2026-08 benchmark, 100-result search response) MessagePack frames were 8.3%
smaller but ~1.9× slower round-trip — V8's native `JSON.stringify`/`parse`
beats the pure-JavaScript msgpack codec roughly 3:1, and the wire savings do
not recover the codec cost. The capability is kept for runtimes or payloads
where that balance flips.

Frame ceilings protect both sides: JSON frames are capped at 64 Mi
characters; binary frames at 256 MiB outbound and a tighter inbound bound for
requests (they are small by construction), rejected from the 5-byte header
before the server waits on or accumulates the declared payload. A garbage or
oversized frame destroys the socket. MessagePack normalizes `undefined` away
before encoding (`nil` would arrive as `null` and change payload shape
between framings), and the search readers treat a `null` filter field as
absent.

## Concurrency

- Read operations may run concurrently.
- SQLite writes are serialized through one server-owned queue.
- Idle-time WAL maintenance: after every write run the daemon arms a sliding
  30s idle timer (override with `WRONGSTACK_INDEX_WAL_IDLE_MS`). When it fires
  — and no reader holds the WAL — the server checkpoints and truncates
  `index.db-wal`, and every 8th fire runs `PRAGMA optimize` to refresh planner
  statistics. Maintenance timers are unref'd, so they never delay the
  daemon's own idle exit.
- Identical unforced full-index requests share one active indexing job and
  receive the same progress stream.
- External file watching is owned and debounced by the server, so opening more
  clients does not multiply project watchers. Ownership is tracked per client;
  the last owner disconnecting closes the watcher and clears its debounce
  timers and pending-file sets.

## Reads during a refresh

While an index refresh is publishing, reads are served from the previous
generation's query caches instead of failing, and the response carries
`stale: true` so callers know the answer predates the run in flight. This
applies to `search`, `packageGraph`, `fileGraph`, `symbolGraph`,
`incomingCalls`, and `outgoingCalls`. A read with no cached answer still fails
with `IndexRefreshInProgressError`: read operations share the server's single
pooled SQLite connection with the in-flight write transaction, so loading
fresh mid-run would read uncommitted rows. `stats` always refuses during a
refresh — it is the progress poll, and a cached pre-run answer would read as
"finished" with old numbers.

The `stale` flag is additive on the wire (`SearchOpResult`,
`IncomingCallsResult`, `OutgoingCallsResult`, and graph results). The read
tools (`codebase-search`, `codebase-incoming-calls`, `codebase-outgoing-calls`)
attempt the query during a refresh rather than refusing upfront, surface
`stale` on their output, and degrade a cache-miss refusal to an advisory
status. The worker/inline fallback path (no server-side cache layer) still
refuses reads for the whole refresh.

Cache preservation across runs: a targeted run (an explicit file list —
per-edit and watcher reindexes, not forced) keeps the query caches on both
success and failure; anything that can reshape the whole index (full scans,
`force` rebuilds, `langs`/`ignore`-filtered runs) clears them on completion
and on failure alike. Preserved entries are generation-tagged, so idle reads
never see them — they only surface, flagged `stale`, inside the next
refresh's window, and only while they lag the publishing generation by at
most two completions (`MAX_STALE_GENERATION_LAG`); an older entry is refused
like a cache miss rather than served as an increasingly outdated answer.

## Vector layer (P4.11)

The 384-dim char-trigram embedding layer is **opt-in** via
`WRONGSTACK_INDEX_VECTORS=1`; the default is off. Measured on a 3000-symbol
corpus (2026-08): recall@10 and MRR are identical with the layer off — the
trigram embedding duplicated the FTS5 trigram tokenizer's lexical ranking —
while the index database is ~55% smaller and full indexing ~2.2× faster.
Opening a legacy database with the gate off drops `symbol_vectors` (its pages
return to the free list); re-enabling plus a force reindex repopulates it.
The RRF fusion path in `searchRanked` remains available when the gate is on.

## Health and control

Clients heartbeat every ten seconds. One missed heartbeat is `degraded`; three
consecutive misses are `unresponsive`. Any valid server message recovers the
connection without killing a possibly busy indexing job.

The server also applies a 45-second client lease. Any request or heartbeat
renews it. A socket that remains open but sends no heartbeat is treated as a
ghost client and disconnected; when that was the final client, the normal idle
shutdown countdown starts. `WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS` changes
the lease and `WRONGSTACK_INDEX_SERVER_IDLE_MS` changes the idle shutdown
delay.

Health snapshots include:

- round-trip latency and missed heartbeat count;
- server uptime, RSS, heap, and external memory;
- connected clients and active requests;
- active and queued writes;
- pending watcher files and current indexing activity.

The TUI status chip shows the connection state and its detail panel shows the
full snapshot. WebUI's `/debug/system` payload exposes the cached server state.
Library users can call `checkCodebaseIndexServerHealth`.

`shutdownCodebaseIndexServer` stops the project server for every client. WebUI
also exposes the privileged `codebase.index.server.shutdown` WebSocket action;
it goes through the normal authorization boundary before shutdown. The WebUI
client correlates the result by request id and never queues this destructive
action for replay after a disconnected session.

## Parser architecture

Symbols are extracted by per-language parser modules loaded lazily by
`parser-dispatch.ts`. Each parser is a standalone module imported only when a
file of its language is encountered — the TypeScript compiler API, for instance,
is never loaded for a Go-only project.

Parser worker threads (`parser-worker-pool.ts`, `parser-worker-script.ts`)
parallelize bulk parsing: when a run holds at least 500 candidate files on a
non-frugal perf profile — the default threshold, overridable via
`WRONGSTACK_INDEX_WORKER_THRESHOLD` (`0` disables the worker path entirely;
unparsable or negative values fall back to the 500 default) — file contents,
already read on the main thread for the content-hash check, are distributed
across up to four worker threads
(cores − 1, clamped) that parse without touching SQLite; all writes stay on
the server thread through one `commitBatch` transaction per outer batch.
Smaller runs, frugal profiles, a `0` threshold, and pool-spawn failures fall
back to inline parsing on the server's event loop, which is already off every
client's main thread.

## Compatibility and recovery

The protocol begins with a versioned handshake. Health payloads are validated at
runtime; a server from an older compatible build may still be reported healthy
without process metrics. Stale Unix sockets and metadata are replaced only
after a direct connection fails, and metadata is removed only by its owning
process. IPC frames are bounded in both framings — 64 Mi characters for
NDJSON, the header-checked binary caps described under Transport — so a
malformed or runaway peer cannot grow an input buffer without bound.
