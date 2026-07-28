# Mailbox Architecture

This document describes the mailbox implementation that ships in WrongStack.
The source of truth is the code under
`packages/core/src/coordination/mailbox-project-server*.ts`,
`remote-mailbox.ts`, and `sqlite-mailbox.ts`.

## Runtime guarantee

All production mailbox data is project-scoped and server-owned:

```text
CLI / agent loop / tools / TUI / WebUI / HQ / HTTP bridge
                         │
                         ▼
                    RemoteMailbox
                         │
              deterministic local IPC
                         │
                         ▼
             one mailbox project server
                         │
                         ▼
 ~/.wrongstack/projects/<project-slug>/_mailbox.sqlite
```

Mailbox data means:

- messages and message metadata;
- actor-scoped read, completion, and outcome receipts;
- agent registrations and heartbeats;
- client registrations and heartbeats;
- schema and legacy-import metadata.

No production component opens `_mailbox.sqlite` directly. Only
`mailbox-project-server.ts` constructs `SqliteMailbox`, and it does so only
after winning the IPC endpoint bind. Production callers use `RemoteMailbox`.
The architecture guard in
`packages/core/tests/architecture/mailbox-ipc-boundary.test.ts` enforces this
boundary.

The old `GlobalMailbox` and `DefaultMailbox` JSONL implementations are
compatibility test adapters. Production construction fails closed; there is no
environment-variable escape hatch back to direct JSONL storage.

## Project identity and paths

Callers resolve the real repository root to WrongStack's canonical project
state directory:

```text
projectRoot: D:\work\repo
projectDir:  ~/.wrongstack/projects/<canonical-slug>
database:    <projectDir>/_mailbox.sqlite
metadata:    <projectDir>/.mailbox-server.json
```

Every surface must use the same `resolveProjectDir` / `projectSlug` path
resolution. Linked worktrees and concurrent clients therefore converge on the
same project mailbox instead of creating per-process stores.

`.mailbox-server.json` is operational owner metadata, not mailbox data. The
server owns and removes it. On Unix the IPC socket is placed below a mode-0700
directory in the OS temp directory; on Windows the endpoint is a named pipe.

## Ownership election and lifecycle

`MailboxProjectServerConnection` derives a deterministic endpoint from the
normalized project directory and protocol version:

- Windows: `\\.\pipe\wrongstack-mailbox-v<version>-<hash>`
- Unix: `<tmp>/wrongstack-mailbox-v<version>/<hash>.sock`

Connection flow:

1. A client attempts the deterministic endpoint.
2. If no owner answers, the client starts a hidden detached Node process.
3. Concurrent starters race to bind the same endpoint.
4. Only the successful listener opens SQLite.
5. Losing starters exit without opening the database.
6. The client accepts the connection only after the protocol version and
   normalized project identity match.

The default lifecycle values are:

| Setting | Default | Source |
|---|---:|---|
| Client IPC heartbeat | 10 seconds | `mailbox-project-server-client.ts` |
| Server client lease | 45 seconds | `mailbox-project-server.ts` |
| Owner idle shutdown | 5 minutes | `mailbox-project-server.ts` |
| IPC request timeout | 30 seconds | `mailbox-project-server-client.ts` |
| IPC frame limit | 16 MiB | `mailbox-project-server-protocol.ts` |

Supported diagnostic/test overrides are
`WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS`,
`WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS`, and
`WRONGSTACK_MAILBOX_SERVER_IDLE_MS`.

`RemoteMailbox.close()` releases the process-shared IPC connection reference.
The final reference closes the socket. Long-lived cached wrappers are evicted
when explicitly closed, so a later caller cannot receive a closed wrapper.
Orderly TUI/WebUI/REPL shutdown deregisters client presence. Agent teardown and
session/project switches deregister the previous agent identity immediately;
the stale TTL remains a crash fallback.

## SQLite model

The owner uses Node's `DatabaseSync` with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Schema version 1 contains:

| Table | Purpose |
|---|---|
| `mailbox_meta` | Schema version and one-time migration markers |
| `messages` | Addressing, type, priority, timestamps, deletion, reply/TTL fields, serialized payload |
| `message_receipts` | Per-message, per-actor read/completion/outcome state |
| `agents` | Agent identity, session, role, status, task/tool counters, heartbeat |
| `clients` | TUI/WebUI/REPL/HTTP client identity and heartbeat |

Receipt writes and message projections are transactional. Broadcast and alias
messages do not have one global completion state: every actor owns an
independent receipt. TUI and actor-aware WebUI responses derive
`completedByMe` and actionable state from that actor's receipt.

## Protocol

Protocol version 3 uses newline-delimited JSON over the local socket/pipe.
Requests carry a numeric ID, operation name, and typed arguments. Responses
carry the same ID and either a result or a serialized error name/message.
Server events are pushed on the same connection.

The operations are:

```text
ping
send                    sendRuntimeControl
query                   unreadCount
ack                     ackMany
softDelete              restore
registerAgent           deregisterAgent
heartbeat               getAgentStatuses
getOnlineAgents         purgeAgents
registerClient          deregisterClient
clientHeartbeat         getClientStatuses
purgeClients
clearAll                purgeStale
autoCompact
shutdown
```

`ping` is the authoritative health response. It includes protocol version,
owner PID, project directory, endpoint, start time, connected IPC clients,
pending requests, database path, and `storageKind: "sqlite"`.

## Addressing and receipts

Recipients use four forms:

| Address | Meaning |
|---|---|
| `leader@<session-tag>` | One exact agent identity |
| `leader` | Base alias visible to matching leader identities |
| `@session` | Normalized to `@session:<sender-session-id>` |
| `*` / `all` | Project broadcast (`all` normalizes to `*`) |

`audience: "leaders"` is an additional visibility restriction; it is not a
recipient address.

`assign` and `steer` require a specific recipient and are rejected for `*` and
session broadcasts. `control` is reserved for runtime code and can only be sent
through `sendRuntimeControl`.

## Retention and migration

The project server owns exactly one automatic compaction timer. The default
sweep runs every five minutes:

- explicit `expiresAt` is honored;
- `status` defaults to a 30-minute TTL;
- other types default to 24 hours when no explicit TTL exists;
- messages read by every currently eligible online agent can be removed after
  10 minutes;
- completed messages default to a one-day stale threshold;
- incomplete messages default to a seven-day stale threshold.

On first SQLite open, the owner transactionally imports supported legacy
message, agent-registry, and client-registry files. It then writes
`legacy_files_imported` to `mailbox_meta`. Legacy files are left unchanged for
manual rollback/recovery and are never written again by production mailbox
code.

## Interface projections

- **Agent loop and tools:** `mail_send`, `mail_inbox`, and `mailbox` resolve the
  project mailbox and use the current session-bound agent identity.
- **TUI:** one registered TUI client refreshes messages, agents, clients,
  actor unread state, and owner health. Events debounce an immediate refresh;
  they do not fabricate message bodies.
- **WebUI:** WebSocket routes return server-backed messages, agents, actor-scoped
  message actions, mutation results, and `mailbox.status`. The panel displays
  `SQLite · IPC pid <pid>`.
  Settings → Connections also probes the project owner and shows its PID,
  endpoint, database path, client/request counts, latency, and uptime.
- **SimpleUI:** the compact `MAIL` workspace drawer uses the same WebSocket
  routes for unread mail, recent messages, online agents, direct sends,
  mark-read/ack/reopen/delete actions, and SQLite/IPC health; background
  agent-loop delivery remains active while the drawer is closed.
- **HQ:** mailbox snapshots include service storage kind, owner PID, connected
  clients, pending requests, and protocol version for each project.
- **CLI:** `/mailbox` exposes inbox, agents, online agents, send, broadcast,
  history, clear, and stale purge.
- **HTTP bridge:** `wstack mailbox serve` is a network façade. Its handlers
  call `RemoteMailbox`; external clients never open SQLite.

The standalone HTTP bridge uses `.mailbox-bridge.lock` and `.mailbox.token` as
discovery/authentication sidecars. Identity credential verifiers live in the
server-owned SQLite database and are read or mutated only through IPC. An
existing `_mailbox_credentials.json` is imported once without being rewritten;
the direct JSON credential adapter is test-only and fails closed in production.

## Failure behavior and diagnostics

- A missing built server entrypoint is an error; there is no direct-file
  fallback.
- Protocol-version or project-identity mismatch closes the connection.
- Oversized or invalid IPC frames close the offending socket.
- Socket errors are contained by the connection/server lifecycle.
- A disconnected surface reports IPC offline while preserving its last useful
  UI snapshot where appropriate.
- SQLite schema versions newer than the running binary are rejected.

Useful checks:

```bash
pnpm exec vitest run mailbox
pnpm exec vitest run packages/core/tests/architecture/mailbox-ipc-boundary.test.ts
pnpm exec vitest run packages/core/tests/coordination/mailbox-project-server.test.ts
pnpm exec vitest run packages/tui/tests/run-tui-mailbox-integration.test.ts
node scripts/purge-stale-mailbox-entries.mjs
```

The purge script is also an IPC client. It does not delete mailbox files
directly.
