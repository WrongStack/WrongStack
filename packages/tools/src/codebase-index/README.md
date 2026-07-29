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

## Concurrency

- Read operations may run concurrently.
- SQLite writes are serialized through one server-owned queue.
- Identical unforced full-index requests share one active indexing job and
  receive the same progress stream.
- External file watching is owned and debounced by the server, so opening more
  clients does not multiply project watchers. Ownership is tracked per client;
  the last owner disconnecting closes the watcher and clears its debounce
  timers and pending-file sets.

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

Parser worker threads (`parser-worker.ts`, `parser-worker-pool.ts`) were removed
in 2026-07 — the lazy dynamic import + `Promise.allSettled` on the main thread
provides adequate parallel parsing, and the detached project server already runs
parsing off the main event loop.

## Compatibility and recovery

The protocol begins with a versioned handshake. Health payloads are validated at
runtime; a server from an older compatible build may still be reported healthy
without process metrics. Stale Unix sockets and metadata are replaced only
after a direct connection fails, and metadata is removed only by its owning
process. Newline-delimited IPC frames have a 64 Mi-character ceiling so a
malformed or runaway peer cannot grow an input buffer without bound.
