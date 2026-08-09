# Session Catalog and Project-Scoped Presence Service Plan — 2026-08

| Field | Value |
|---|---|
| **Status** | Implemented and fully validated |
| **Owner** | Core storage, runtime, CLI, WebUI server, and HQ maintainers |
| **Created** | 2026-08-08 |
| **Last verified against source** | 2026-08-08 |
| **Scope** | Project-scoped session ownership, live presence, catalog/index operations, and cross-surface session discovery |
| **Out of scope for the first release** | Moving the high-frequency transcript append path behind IPC |
| **Related architecture** | [`../architecture.md`](../architecture.md), [`adr-003-authority-first-refactor-program.md`](adr-003-authority-first-refactor-program.md) |

---

## 1. Executive decision

WrongStack will introduce one authenticated, detached **Session Catalog project service** for each
canonical project. The service will become the sole production authority for:

- session ownership claims and resume exclusion;
- live client and agent presence;
- session catalog/index mutations;
- rename, delete, prune, rewind, and other maintenance admission decisions;
- cross-process session list, summary, and presence subscriptions;
- project-local session health and operational diagnostics.

The first release will **not** move every `SessionEvent` append through IPC. A live session process
will continue to own its one append-only JSONL writer and its buffered file handle. This preserves
the current streaming hot path and crash-recovery format. The daemon will own shared coordination
and catalog state, while session JSONL remains the durable conversation record.

The intended authority split is:

| Concern | Authoritative owner |
|---|---|
| Conversation and reconstruction events | Per-session JSONL transcript |
| Workspace checkpoint content | Existing session checkpoint/CAS artifacts |
| Live session claim and resume exclusion | Session Catalog daemon |
| Live client and agent presence | Session Catalog daemon lease state |
| Session names and summary sidecars | Mutated only through the Session Catalog boundary after cutover |
| Catalog query acceleration | Rebuildable Session Catalog SQLite database |
| Delete, prune, clear, truncate, rewind admission | Session Catalog maintenance lease |
| HQ/WebUI live session projection | Daemon query/subscription, with remote HQ forwarding by an attached runtime |

This is an authority-first migration. The existing `SessionRegistry` and `DefaultSessionStore`
interfaces remain compatibility surfaces during rollout, but they must eventually delegate to the
project service instead of opening a second cross-process authority.

---

## 2. Why this project exists

### 2.1 Current live ownership is device-global

`packages/core/src/session-registry.ts` stores all active sessions from all projects in one
`~/.wrongstack/session-registry.json` file. Each process:

- registers one current session;
- writes a heartbeat every five seconds;
- updates a bounded agent snapshot;
- takes an advisory lock;
- performs a read-modify-write of the registry;
- probes stale PIDs and prunes dead entries during reads.

This design correctly protects explicit resume ownership today, but it has a global contention
domain. Activity in one large project can delay registry writes for an unrelated project. The
registry also has to mix discovery, ownership, liveness, telemetry, stale cleanup, and atomic file
recovery in one file protocol.

### 2.2 Session catalog work is repeated in each process

`packages/core/src/storage/session-store.ts` gives every `DefaultSessionStore` instance its own:

- parsed-session load cache;
- `_index.jsonl` cache;
- shard manifest cache;
- session ID resolution scan;
- summary rebuild work;
- index compaction and file-lock path.

CLI, TUI, standalone WebUI, embedded WebUI, HQ routes, rewind commands, project switching, and
director helpers create separate store or registry instances. File locking protects writes, but it
does not prevent duplicated scans, duplicated parsing, stale per-process caches, or repeated
cross-process liveness reconstruction.

### 2.3 Live presence is a projection, but today it shares the ownership file

`SessionRegistryEntry` carries both correctness-critical ownership fields and UI-oriented live data:

- session and project identity;
- PID and start generation;
- client type and working directory;
- heartbeat and derived status;
- WebUI endpoint hints;
- agent status, partial streaming text, recent tools, mail, todos, and activity totals.

Ownership changes are rare and must be strongly serialized. Presence updates are frequent,
best-effort, bounded projections. Persisting both through the same global JSON rewrite creates an
unnecessary coupling between two different consistency classes.

### 2.4 Polling and reconstruction leak into surfaces

WebUI and HQ handlers repeatedly construct `SessionRegistry` and `DefaultSessionStore` to answer
session routes. The WebUI fleet broadcaster reads the global registry and produces its own filtered
projection. The result is more filesystem work, slower outage detection, and more places that must
reimplement stale-session semantics.

### 2.5 The project-daemon pattern already exists

Mailbox, Chronicle, SAGE, Kanban, and Codebase Index already use the target lifecycle shape:

```text
client process
    -> deterministic local IPC endpoint
    -> elected detached project owner
    -> one SQLite/watcher authority
```

The Session Catalog service should reuse the same invariants: canonical project identity, endpoint
versioning, bind-before-store election, authenticated requests, bounded frames and queues,
heartbeat leases, fail-closed production access, and explicit recovery-only inline mode.

---

## 3. Goals and non-goals

### 3.1 Goals

1. Remove the device-wide session ownership write lock from normal project operation.
2. Make explicit resume ownership atomic and project-scoped.
3. Preserve the rule that every TUI, WebUI, SimpleUI, CLI, and REPL starts a fresh session unless
   the operator explicitly selects resume/recovery.
4. Provide push-based live presence to attached surfaces without making notifications authoritative.
5. Centralize session catalog list, resolve, rename, delete, prune, and rebuild behavior.
6. Retain JSONL as a durable, inspectable, append-only transcript format.
7. Preserve current secret scrubbing before any value reaches durable storage or live presence.
8. Keep a running agent productive through a temporary daemon restart after it already owns its
   transcript writer, while blocking new conflicting ownership or maintenance operations.
9. Support local HQ aggregation across all known projects and preserve remote HQ telemetry.
10. Make the catalog database rebuildable from transcript and summary artifacts.
11. Expose common health data through the existing `connections.health` operational surface.
12. Provide an incremental migration with parity evidence and rollback at every phase.

### 3.2 Non-goals

The initial project will not:

- send every token delta or every session event over IPC;
- replace transcript JSONL with SQLite;
- merge session content with Mailbox, Chronicle, SAGE, Kanban, or Governance databases;
- expose the project daemon over TCP, HTTP, WebSocket, or a remotely reachable interface;
- let HQ directly mutate a project daemon across machines;
- centralize Agent, ToolExecutor, provider streaming, permission prompts, or context compaction;
- change the fresh-session-by-default product behavior;
- allow two processes to append to one session transcript;
- silently fall back to a private production store when the daemon build is missing;
- delete compatibility code in the same slice that introduces its replacement.

---

## 4. Architectural invariants

The implementation must preserve all of the following.

1. **One project authority.** Every process resolving the same canonical project and WrongStack
   state root reaches the same endpoint.
2. **Bind before database open.** A losing daemon candidate never opens `catalog.sqlite`.
3. **One live writer per session.** A session claim or resume reservation succeeds for at most one
   owner generation.
4. **JSONL remains the content authority.** Catalog loss cannot destroy the transcript; the catalog
   can be rebuilt.
5. **No implicit inline fallback.** Production access fails closed unless an explicit recovery/test
   switch requests inline mode.
6. **A socket is not a lease.** Live ownership requires authenticated heartbeats and a valid lease.
7. **Notifications are hints.** After reconnect, cursor gaps, or overflow, clients query a fresh
   authoritative snapshot.
8. **Presence is bounded.** Partial text, recent tools, mail, todos, activity paths, agent counts,
   subscribers, frames, and write queues all have explicit limits.
9. **Secrets never enter catalog state accidentally.** Existing scrubbers and new wire validators
   run before persistence or broadcast.
10. **Maintenance is exclusive.** Delete, clear, truncate, rewind, prune, and destructive repair do
    not run against a live or reserved session.
11. **Project switching does not abandon ownership.** The old project lease is released only after
    the new project/session path is safely established or the switch is rolled back.
12. **A daemon outage does not corrupt an already-open transcript.** Existing writers may continue
    buffered appends during a bounded reconnect window; new claims and destructive operations do not.
13. **HQ is an observer, not an owner.** HQ projections do not grant session ownership or bypass the
    project service.
14. **Compatibility is temporary and measurable.** Dual-write/shadow paths have removal criteria.

---

## 5. Target architecture

```text
                              local machine

  CLI/TUI process                standalone WebUI              local HQ
  +------------------+           +------------------+          +------------------+
  | Agent + writer   |           | session surface  |          | project aggregator|
  | SessionCatalog   |           | SessionCatalog   |          | daemon discovery  |
  | client           |           | client           |          | + subscriptions   |
  +--------+---------+           +--------+---------+          +---------+--------+
           |                              |                              |
           +------------------------------+------------------------------+
                                          |
                               authenticated local IPC
                                          |
                     +--------------------v--------------------+
                     | Session Catalog project daemon          |
                     |                                         |
                     | claim/reservation/lease state            |
                     | bounded presence and subscriptions       |
                     | catalog queries and maintenance gates    |
                     | summary/index reconciliation             |
                     +----------------+------------------------+
                                      |
                  +-------------------+-------------------+
                  |                                       |
       +----------v-----------+                +----------v-----------+
       | catalog.sqlite       |                | sessions/ artifacts  |
       | rebuildable catalog  |                | JSONL + summary + CAS|
       +----------------------+                +----------------------+
```

### 5.1 Proposed source ownership

The default placement is a new Core domain because the current session contracts and concrete file
store already live in Core:

```text
packages/core/src/session-catalog/
├── types.ts
├── protocol.ts
├── endpoint.ts
├── metadata.ts
├── sqlite-catalog.ts
├── schema.ts
├── rebuild.ts
├── project-server.ts
├── project-server-client.ts
├── remote-registry.ts
├── remote-session-store.ts
├── presence-bounds.ts
└── errors.ts
```

The exact file split can change during implementation, but the dependency direction cannot:

- protocol/types must not import CLI, WebUI, or surface packages;
- server owns SQLite and filesystem reconciliation;
- client owns connection, election/retry, heartbeat, and local callbacks;
- compatibility adapters implement existing Core interfaces;
- CLI/WebUI/HQ depend on the adapters, not the server implementation.

If the internal Core architecture rule rejects a new top-level domain, Phase 0 must record the final
placement before implementation. Moving this logic into CLI or WebUI is not an acceptable shortcut.

### 5.2 Project state layout

Given `projectDir = ~/.wrongstack/projects/<slug>/`:

```text
<projectDir>/
├── .session-catalog-server.json     # owner-only daemon metadata + auth token
├── sessions/
│   ├── catalog.sqlite               # rebuildable catalog + durable lease records
│   ├── 2026-08-08/
│   │   ├── sess_<ULID>.jsonl        # transcript authority
│   │   └── sess_<ULID>.summary.json # portable summary metadata
│   └── _cas/                        # existing workspace checkpoint CAS
└── ...other project services...
```

The endpoint key must hash the resolved `projectDir`, not only the checkout path. This prevents two
different `WRONGSTACK_HOME` roots from colliding while preserving the existing linked-worktree
canonicalization behavior.

### 5.3 Process lifecycle

1. Client computes the versioned endpoint from canonical `projectDir`.
2. Client probes an existing owner and validates protocol/project identity.
3. If absent, one client launches the built project-server entrypoint detached.
4. Socket/named-pipe bind elects the owner.
5. Only the elected owner opens `sessions/catalog.sqlite`.
6. Owner writes mode-`0600` metadata containing the auth token and public health fields.
7. Clients authenticate, claim or attach, then begin heartbeat.
8. Live leases keep the daemon alive; an open socket without a current lease does not.
9. With no clients, leases, maintenance work, rebuild, or subscribers, the daemon exits after the
   configured idle interval.
10. Shutdown closes subscriptions, SQLite statements, sockets, metadata, and Unix socket artifacts
    in a defined order.

---

## 6. Data model

The schema below is a design contract, not final SQL syntax. Migrations must be versioned and
transactional.

### 6.1 `catalog_meta`

| Column | Purpose |
|---|---|
| `key` | Schema/build/rebuild metadata key |
| `value_json` | Bounded serialized value |

Required keys include schema version, build identity, last full rebuild, last reconciliation,
source layout version, and catalog generation.

### 6.2 `sessions`

| Column | Purpose |
|---|---|
| `session_id` | Canonical sharded session ID, primary key |
| `transcript_relative_path` | Contained path below `sessions/` |
| `summary_relative_path` | Contained summary sidecar path |
| `started_at`, `ended_at`, `last_activity_at` | Ordering and lifecycle |
| `title`, `name` | Scrubbed display metadata |
| `provider`, `model` | Historical execution metadata |
| `message_count`, `iteration_count`, `tool_call_count` | Summary counters |
| `token_total`, `file_change_count`, `compaction_count` | Summary counters |
| `outcome` | Final/current catalog outcome |
| `transcript_size`, `transcript_mtime_ms` | Cache validation identity |
| `summary_revision` | Monotonic daemon-managed revision |
| `indexed_at` | Last successful catalog update |
| `damaged` | Summary/transcript validation failed |

Every stored path is relative, normalized, and re-contained against the sessions root before use.
Arbitrary paths from clients are rejected.

### 6.3 `session_leases`

| Column | Purpose |
|---|---|
| `session_id` | Claimed session, primary key |
| `lease_id` | Public opaque lease identifier |
| `lease_secret_hash` | Hash of reconnect proof; raw secret is returned once |
| `owner_instance_id` | Random process-generation identity |
| `owner_pid` | Diagnostic/liveness probe PID |
| `owner_started_at` | Protects against PID reuse |
| `client_type` | `tui`, `webui`, `simpleui`, `cli`, `repl`, or future value |
| `working_dir` | Contained/validated diagnostic context |
| `status` | `starting`, `active`, `idle`, `waiting`, `closing`, `lost` |
| `last_heartbeat_at` | Last accepted authenticated heartbeat |
| `lease_expires_at` | Takeover gate |
| `webui_endpoint_json` | Strictly decoded, bounded endpoint hint |

The raw lease secret must never be written to metadata, logs, Chronicle, SQLite, or an HQ payload.
Only its hash is durable so a live process can prove continuity after daemon restart.

### 6.4 `resume_reservations`

| Column | Purpose |
|---|---|
| `reservation_id` | Opaque reservation token |
| `target_session_id` | Session being resumed |
| `requester_instance_id` | Process generation |
| `current_session_id` | Optional session currently owned by the requester |
| `created_at`, `expires_at` | Short transaction window |
| `state` | `reserved`, `activated`, `cancelled`, `expired` |

Reservations prevent another process from opening the target while the requester loads and validates
the transcript. They expire quickly and do not count as a live session until activated.

### 6.5 `agent_presence`

| Column | Purpose |
|---|---|
| `session_id`, `agent_id` | Composite identity |
| `revision` | Reject stale/out-of-order snapshots |
| `status`, `current_tool`, `current_task` | Primary live projection |
| `last_activity_at` | Liveness/display ordering |
| `payload_json` | Remaining strictly bounded, scrubbed presence fields |

Presence may be retained primarily in memory and checkpointed selectively. It must never force one
SQLite transaction per streamed token. A restart may temporarily lose optional partial text, but it
must not lose ownership leases or permit a conflicting resume.

### 6.6 `maintenance_leases`

| Column | Purpose |
|---|---|
| `session_id` | Target session |
| `operation` | `delete`, `prune`, `clear`, `truncate`, `rewind`, `repair` |
| `holder_id` | Authenticated requester identity |
| `acquired_at`, `expires_at` | Bounded exclusive operation window |

A maintenance lease is refused when a live lease or resume reservation exists. A live claim is
refused while maintenance is active.

### 6.7 SQLite behavior

- WAL mode, foreign keys, busy timeout, and shared WrongStack performance-profile pragmas.
- Prepared statement reuse and bounded in-memory caches.
- All claim/reservation/activation transitions use explicit transactions.
- Rebuild uses a staging generation and swaps catalog visibility only after successful validation.
- Catalog corruption fails visibly and offers an explicit rebuild path; it does not delete JSONL.
- SQLite is opened only inside the elected daemon process.

---

## 7. Wire protocol

### 7.1 Transport and framing

- Windows named pipe or Unix-domain socket.
- Newline-delimited JSON frames, matching existing project services.
- Protocol version embedded in endpoint path and repeated in `hello`.
- Per-request ID with exactly one terminal response.
- Auth token required on every request that exposes session data or changes state.
- Strict runtime decoding with unknown-field rejection for ownership and maintenance operations.
- Explicit maximum frame, string, array, agent, and result sizes.
- Bounded per-client write queue; slow subscribers are disconnected.

### 7.2 Core operations

| Operation | Consistency | Purpose |
|---|---|---|
| `ping` | Read | Protocol, owner, queue, DB, lease, and rebuild health |
| `claim_new` | Transactional | Claim a freshly generated session ID before activation |
| `reserve_resume` | Transactional | Reserve an existing session for safe hydration |
| `activate_reservation` | Transactional | Convert reservation into the live lease |
| `cancel_reservation` | Idempotent | Release a failed resume attempt |
| `heartbeat` | Lease write | Refresh owner continuity and compact session status |
| `publish_agents` | Revisioned best-effort | Publish bounded agent presence |
| `mark_closing` | Idempotent | Stop normal heartbeat and expose graceful shutdown |
| `release` | Exact-owner transactional | Remove only the matching owner generation |
| `list_live` | Snapshot read | Current project live sessions |
| `get_live` | Snapshot read | One live session and agents |
| `subscribe` | Hint stream | Presence/catalog invalidation events from a cursor |
| `list_catalog` | Snapshot read | Paged/filterable historical session summaries |
| `resolve_id` | Read | Exact leaf/unique prefix resolution |
| `get_summary` | Read | One scrubbed catalog summary |
| `notify_transcript_changed` | Hint/write | Invalidate file identity and schedule reconciliation |
| `rename` | Transactional mutation | Update portable summary and catalog atomically |
| `acquire_maintenance` | Transactional | Claim exclusive destructive/read-rewrite operation |
| `release_maintenance` | Exact-owner | End operation lease |
| `delete` | Transactional mutation | Validate lease and delete known artifacts |
| `prune` | Transactional/batched | Remove eligible closed sessions |
| `rebuild_catalog` | Exclusive admin | Rebuild SQLite from files |

### 7.3 Notification events

Notification payloads are invalidation hints, not state replication:

- `session.claimed`
- `session.presence_changed`
- `session.closing`
- `session.released`
- `session.lost`
- `session.catalog_changed`
- `session.deleted`
- `session.rebuild_started`
- `session.rebuild_completed`
- `session.health_changed`

Each event carries daemon instance ID, monotonic sequence, project identity, session ID when
applicable, and a bounded revision. If the daemon instance changes or a cursor gap is detected, the
client discards incremental assumptions and rereads `list_live` or the relevant catalog page.

### 7.4 Presence bounds

The implementation must define and test limits for at least:

- agents per session;
- partial assistant text characters;
- recent tools and mail entries per agent;
- todo entries and per-field string lengths;
- file paths retained in activity totals;
- total serialized agent snapshot bytes;
- subscriber count and pending frames per client;
- catalog page size and search result count.

Oversized optional presence fields are truncated with an explicit `truncated` marker. Invalid
ownership fields reject the entire request.

---

## 8. Ownership and lifecycle state machines

### 8.1 Fresh session

```text
generated
   -> claim_new(starting lease)
   -> create JSONL writer
   -> activate lease
   -> active/idle/waiting
   -> mark_closing
   -> writer flush + close + summary publish
   -> release
```

If writer creation fails, the client releases the `starting` lease. Another fresh ID is generated on
retry; the system does not recycle a partially created identity silently.

### 8.2 Explicit resume

```text
current session remains owned
   -> reserve_resume(target)
   -> load + validate target transcript
   -> open target append handle
   -> activate_reservation(target)
   -> swap runtime writer/context
   -> close and release previous session
```

Failure before activation closes the target handle, cancels the reservation, and leaves the current
identity untouched. Activation is refused if the reservation expired or no longer belongs to the
requester generation.

### 8.3 Project switch

Cross-project switching spans two daemons and therefore cannot be one database transaction. The safe
order is:

1. Resolve and connect to the target project daemon.
2. Claim/reserve the target session.
3. Create or hydrate the target writer and project-scoped runtime state.
4. Activate the target lease.
5. Atomically swap local runtime references.
6. Close and release the previous project session.
7. If steps 1–5 fail, clean up the target and preserve the previous project/session.

A short overlap where one process owns one session in each project is acceptable and must be marked
`switching`; a gap where it owns neither before the local swap is not.

### 8.4 Crash and stale takeover

- Heartbeats refresh the lease deadline.
- Two missed intervals make the lease suspect; expiration makes it `lost`.
- A live PID with matching start generation prevents automatic takeover even after heartbeat loss.
- A dead PID permits cleanup after the expiration/grace rule.
- PID reuse is rejected by owner start generation and lease proof.
- Operators must terminate an unreachable but provably live owner before takeover.
- Recovery tooling may expose an explicit force path with confirmation and audit; ordinary resume
  cannot force ownership.

### 8.5 Daemon restart

The catalog database retains lease ID, hashed reconnect proof, owner generation, PID, and deadline.
After restart:

1. Client discovers new daemon metadata and authenticates.
2. Client sends lease ID, raw reconnect proof, and owner generation.
3. Daemon verifies the stored hash and PID/start identity.
4. Matching clients resume heartbeat without releasing ownership.
5. Optional agent partial-text state is republished from the client.

No other process can win the session merely by reconnecting first without the lease proof.

---

## 9. Session writer and catalog interaction

### 9.1 Initial hybrid model

`FileSessionWriter` keeps its existing responsibilities:

- scrub and observe events;
- buffer and batch JSONL appends;
- retry transient append failures;
- flush at explicit boundaries;
- track open tool uses;
- write checkpoints and file snapshots;
- close the file handle safely on Windows.

The daemon is notified only at coarse boundaries:

- writer created/resumed;
- transcript flush advanced file size/revision;
- summary changed;
- writer closed;
- transcript truncated/cleared;
- checkpoint availability changed, if catalog display needs it.

This avoids an IPC round trip for every model delta and tool event.

### 9.2 Summary cutover

The current writer writes `.summary.json` and calls `DefaultSessionStore.appendToIndex()` during
close. Migration proceeds in two steps:

1. **Shadow reconciliation:** writer retains sidecar/index behavior and notifies the daemon. Daemon
   compares its derived row with the portable summary and records parity diagnostics.
2. **Catalog authority:** writer sends the finalized scrubbed summary to the daemon. The daemon
   validates it, writes the sidecar, updates SQLite, and emits one catalog revision. Direct
   `_index.jsonl` append is removed.

`_index.jsonl` may remain a generated compatibility projection for one release if a downstream tool
still consumes it. It must not remain a second mutable authority.

### 9.3 Active session reads

Reading an append-only active transcript remains safe. The daemon can cache parsed results by
`mtime + size + summary_revision`. Writer notifications accelerate invalidation; file identity is
still checked before a cached result is served.

The first release may leave full transcript loading in the client store. Moving load/search behind a
streaming IPC response is optional later work and requires separate memory/latency measurement.

---

## 10. Surface integration

### 10.1 Runtime container

`packages/runtime/src/container.ts` currently constructs `DefaultSessionStore` and consults the
global registry in `isSessionInUse`. During migration it should bind compatibility adapters:

- `RemoteSessionRegistry` for ownership/presence;
- `ProjectSessionStore` or `RemoteSessionCatalogStore` for shared catalog operations;
- existing `FileSessionWriter` factory for local transcript writers.

`isSessionInUse` becomes a daemon query or is removed once delete is itself daemon-owned.

### 10.2 CLI/TUI

Update these behavioral paths without changing their user-facing defaults:

- boot registration and AgentStatusTracker publication;
- fresh session claim;
- explicit TUI resume;
- project switch;
- `/session` list, rename, clear, delete, and resume;
- `wstack rewind` temporary claim/maintenance lease;
- graceful shutdown and exact-owner release;
- diagnostic/doctor output.

The existing `activateSession()` compatibility callback can delegate to the two-phase reservation
flow until call sites adopt a more explicit API.

### 10.3 WebUI and SimpleUI

Replace repeated per-route registry construction with one project client owned by backend services.
Use subscriptions for live presence and catalog invalidation. HTTP handlers query the client-owned
snapshot/cache rather than rereading the global registry file on every request.

Session start/resume/project-switch paths follow the same reservation rules as TUI. No surface may
invent weaker ownership semantics.

### 10.4 Local HQ

Local HQ needs an aggregator because there is no longer one global registry file. It should:

1. enumerate known `~/.wrongstack/projects/*` directories;
2. read each owner-only metadata file as a discovery hint;
3. probe and authenticate the local daemon;
4. subscribe to live-session hints;
5. merge snapshots by canonical project identity;
6. drop/reprobe daemons on instance change or disconnect.

Directory enumeration must be bounded and cached. A missing/offline daemon is not automatically an
error for an inactive project.

### 10.5 Remote HQ

The project daemon remains local-only. An attached WrongStack runtime continues to forward scrubbed,
bounded session telemetry to remote HQ through the existing HQ channel. Remote HQ cannot present a
daemon lease credential or mutate local session ownership.

### 10.6 Connections health

Add a `session-catalog` row with:

- mode and protocol version;
- owner PID and uptime;
- endpoint and storage status without secrets;
- connected clients and live leases;
- reservations and maintenance leases;
- pending requests and slow-client disconnect count;
- catalog rows, damaged rows, rebuild status, and last reconciliation;
- watcher/reconnect state where applicable;
- measured ping latency and last error.

---

## 11. Security and trust boundary

### 11.1 Local authentication

- Metadata file is mode `0600` where supported.
- Shared daemon auth token never appears in the public `hello` frame.
- Windows named pipes receive the same application-layer auth requirement as Unix sockets.
- Session lease secrets are separate from the daemon auth token.
- Raw lease secrets are returned once and stored only by the owning client process.
- Shutdown and rebuild operations require stronger/admin capability than ordinary presence reads.

### 11.2 Input validation

- Reject unknown fields in claim, reservation, lease, and maintenance frames.
- Canonicalize and compare project identity at hello and request boundaries.
- Never accept an arbitrary database, transcript, summary, or CAS path from a client.
- Validate session IDs and derive paths server-side.
- Bound JSON depth, array lengths, strings, and total frames.
- Scrub display strings, prompts, tool receipts, mail previews, and partial text before persistence.
- Do not broadcast environment variables, auth headers, provider credentials, tool raw secrets, or
  unbounded tool input/output.

### 11.3 Authorization tiers

| Capability | Typical holders | Operations |
|---|---|---|
| `presence_read` | TUI/WebUI/HQ local observer | List/get/subscribe presence |
| `catalog_read` | Session surfaces, HQ | List/resolve/get summary |
| `session_claim` | Runtime host | Claim, reserve, activate, heartbeat, release |
| `presence_write` | Owning runtime | Publish its exact session/agent snapshot |
| `catalog_write` | Owning writer/runtime | Notify change, publish finalized summary |
| `maintenance` | Confirmed CLI/WebUI action | Rename/delete/prune/rewind/clear |
| `admin` | Doctor/repair tooling | Rebuild, controlled shutdown, credential rotation |

An owning runtime can update only its exact lease. It cannot publish presence as another live owner.

### 11.4 Audit

Ownership conflicts, force-recovery attempts, destructive maintenance, rebuilds, corruption, and
credential lifecycle changes emit scrubbed Chronicle events. Ordinary heartbeats and partial-text
updates must not create unbounded audit traffic.

---

## 12. Failure semantics

| Failure | Required behavior |
|---|---|
| Built daemon entrypoint missing | Fail closed; mention explicit recovery/test escape hatch |
| Endpoint occupied by compatible owner | Attach to owner |
| Endpoint occupied by incompatible/invalid owner | Fail loudly; do not open private catalog |
| SQLite unavailable/corrupt | Refuse catalog authority; preserve JSONL; offer explicit rebuild/repair |
| Daemon dies before session claim | Block new session/resume until reconnect/election succeeds |
| Daemon dies during active run | Existing writer continues; ownership-changing and destructive operations block; client reconnects |
| Heartbeat temporarily fails | Keep local writer; expose degraded presence; retry within lease window |
| Lease expires but PID is live | Mark lost; refuse automatic takeover |
| Owner PID is dead | Reap after grace and permit a new reservation |
| Presence snapshot too large | Truncate optional fields or reject invalid ownership fields; never grow queues unboundedly |
| Slow subscriber | Disconnect it; client rereads snapshot after reconnect |
| Catalog cursor gap | Return gap/instance change; client rereads authoritative snapshot |
| Summary/index update fails after JSONL close | Preserve transcript, mark catalog damaged/stale, retry reconciliation |
| Project switch target fails | Cancel target work and retain previous project/session |
| Shutdown races a late update | Exact-owner generation check prevents resurrection |

### 12.1 Explicit recovery mode

If an inline/test adapter is retained, require a deliberately named switch such as
`WRONGSTACK_SESSION_CATALOG_INLINE=1`. It must be documented as recovery/testing only, visually
reported in health diagnostics, and covered by the architecture fail-closed ratchet. It must not be
entered because `dist/session-catalog/project-server.js` is missing.

---

## 13. Performance and resource budgets

Phase 0 records current baselines before setting absolute numbers. The implementation is accepted
only if it satisfies these relative constraints:

1. Heartbeat no longer rewrites a device-global registry file.
2. One project has one catalog SQLite connection regardless of attached surfaces.
3. A heartbeat does not parse session JSONL or scan the sessions directory.
4. Presence publication is coalesced and bounded; streaming deltas do not map one-to-one to IPC or
   SQLite writes.
5. Warm catalog list and ID resolution avoid directory scans.
6. Starting an additional TUI/WebUI for the same project does not create another catalog cache or
   full index parse.
7. The transcript append/flush latency does not regress materially in the hybrid phase.
8. Daemon RSS, handles, timers, queue depth, and idle shutdown are measured under 1, 10, and 100
   simulated sessions.
9. A 100-session heartbeat burst remains bounded and does not starve catalog reads.
10. Rebuild memory is bounded by streaming/sharded processing rather than loading all transcripts.

Benchmarks should report median/p95/p99 where meaningful, total bytes read/written, lock wait time,
SQLite transaction count, event-loop delay, RSS peak, and handle count. Do not claim a performance
gain from architecture alone.

---

## 14. Migration program

### Phase 0 — Characterization and contract freeze

**Purpose:** establish evidence before introducing a second implementation.

Tasks:

- Capture current fresh session, resume, failed resume rollback, project switch, rewind, delete,
  prune, closing, crash, and stale-owner journeys.
- Add fixtures for every `SessionRegistryEntry` field and existing session summary behavior.
- Measure registry lock/write behavior and repeated store scans with multiple processes.
- Enumerate all production `SessionRegistry` and `DefaultSessionStore` constructors.
- Record the final Core module placement and architecture-layer effect.
- Define protocol limits and schema version policy.
- Add the future service to the project-daemon architecture plan/gate as a pending migration entry.

Exit gate:

- Current behavior is represented by deterministic tests across CLI, WebUI server, and Core.
- Baseline measurements and all constructors/call sites are documented.
- No production behavior has changed.

### Phase 1 — Daemon, protocol, and rebuildable catalog in shadow mode

**Purpose:** build the service without making it the ownership authority.

Tasks:

- Add endpoint, protocol, metadata, server, client, and SQLite schema.
- Implement bind-before-open election and authenticated health.
- Import/rebuild summaries from existing transcript and sidecar layout.
- Start the daemon lazily from an explicit client connection.
- Shadow-notify session create/close/rename/delete without changing current outcomes.
- Compare daemon catalog results with `DefaultSessionStore.list()` and `resolveId()`.
- Add `connections.health` diagnostics behind a non-required status row.

Exit gate:

- Real IPC integration passes on a fresh temporary project.
- Shadow parity reports zero unexplained session ID/summary differences.
- Killing/restarting the daemon cannot corrupt JSONL or sidecars.
- Existing registry remains the only claim authority in this phase.

### Phase 2 — Project-scoped presence dual publication

**Purpose:** move high-frequency live telemetry off the global JSON file while retaining rollback.

Tasks:

- Publish ownership/presence to both old registry and daemon.
- Add revisioned `publish_agents` and snapshot subscriptions.
- Switch WebUI fleet broadcaster to daemon presence under a feature gate.
- Add a local HQ project-daemon aggregator.
- Compare live session sets, status, agent counts, and owner generations.
- Measure heartbeat writes, lock waits, latency, and dropped/coalesced snapshots.

Exit gate:

- Multi-process live presence parity remains stable through start, idle, tool work, waiting-user,
  project switch, closing, and crash.
- Slow subscribers cannot grow daemon memory unboundedly.
- Old registry can still be selected as rollback authority.

### Phase 3 — Claim and resume authority cutover

**Purpose:** make the daemon the sole session ownership decision point.

Tasks:

- Implement new claim and two-phase resume reservation flows.
- Route TUI, WebUI, SimpleUI, CLI, REPL, rewind, and project switch through them.
- Persist hashed reconnect proof and validate daemon restart continuity.
- Retain old registry as a read-only compatibility projection for one release.
- Prevent old registry writes from making ownership decisions.
- Add explicit conflict and force-recovery UX.

Exit gate:

- Concurrent resume attempts produce exactly one winner.
- Failed hydration restores the previous session without a phantom claim.
- Daemon restart does not permit a second owner.
- A clean close disappears immediately; a crash follows tested stale rules.
- Every surface preserves fresh-session-by-default behavior.

### Phase 4 — Catalog read and mutation cutover

**Purpose:** centralize shared session catalog behavior.

Tasks:

- Route list/filter/resolve/get-summary through the daemon.
- Route rename/delete/prune/clear/rewind admission through maintenance leases.
- Replace repeated WebUI/HQ store construction with shared client adapters.
- Make catalog sidecar/index updates daemon-owned.
- Turn `_index.jsonl` into a temporary generated projection or remove it after consumer scan.
- Add repair/rebuild commands and damaged-row diagnostics.

Exit gate:

- No production process outside the daemon mutates shared session index/summary state.
- Active/reserved sessions cannot be deleted, pruned, truncated, cleared, or rewound.
- Catalog rebuild reproduces portable session summaries.
- WebUI/HQ session routes no longer scan the global registry on each request.

### Phase 5 — Remove global registry authority and compatibility locks

**Purpose:** finish the migration and delete the second authority.

Tasks:

- Stop writing `~/.wrongstack/session-registry.json`.
- Remove device-global heartbeat and stale-temp maintenance.
- Remove compatibility constructors/call paths after usage scan.
- Delete obsolete `_index.jsonl` write locks if the projection is gone.
- Add Session Catalog to the bidirectional project-daemon architecture ratchet.
- Update architecture, troubleshooting, doctor, and release documentation.

Exit gate:

- Source scan finds no production direct ownership writes to the old registry.
- All live/catalog operations use the project daemon.
- Full focused suites, architecture gate, build, typecheck, and release-relevant checks pass.
- Rollback now means reverting the release, not silently activating a second authority.

### Phase 6 — Optional transcript query service

This is deliberately optional and requires measured evidence. Candidate work:

- stream session detail reads over IPC;
- centralize full-text event search;
- share parsed active-session tails;
- centralize replay/audit sidecar discovery;
- provide paged event reads to HQ/WebUI.

Do not start this phase unless repeated transcript parsing remains a measured bottleneck after the
catalog migration. The JSONL writer can remain permanently local.

---

## 15. Dependency-aware task graph

| ID | Task | Depends on | Primary areas | Exit evidence |
|---|---|---|---|---|
| `SC-00` | Characterize current lifecycle | — | Core/CLI/WebUI tests | Journey and contention baselines |
| `SC-01` | Freeze protocol, limits, placement | `SC-00` | Core architecture | Reviewed types and boundary decision |
| `SC-02` | Endpoint/election/metadata/client | `SC-01` | Core session-catalog | Real IPC health and auth tests |
| `SC-03` | SQLite catalog + rebuild | `SC-02` | Core storage | Rebuild/parity/corruption tests |
| `SC-04` | Shadow catalog integration | `SC-03` | Runtime/store/writer | Zero unexplained parity drift |
| `SC-05` | Presence publication/subscription | `SC-02` | Runtime/WebUI/HQ | Multi-process live parity and bounds |
| `SC-06` | Lease proof + daemon restart | `SC-02` | Server/client/schema | Reconnect/takeover adversarial tests |
| `SC-07` | Claim/reservation API | `SC-06` | Core adapters | Exactly-one-winner race tests |
| `SC-08` | CLI/TUI resume and switch cutover | `SC-07` | CLI/TUI | Lifecycle journey parity |
| `SC-09` | WebUI/SimpleUI cutover | `SC-07` | WebUI server/surfaces | Session lifecycle integration tests |
| `SC-10` | Local HQ aggregator | `SC-05` | CLI HQ/WebUI HQ | Cross-project aggregation tests |
| `SC-11` | Catalog read adapters | `SC-04` | Runtime/Core/WebUI/HQ | List/resolve/filter parity |
| `SC-12` | Maintenance lease/mutations | `SC-07`, `SC-11` | Core/CLI/WebUI | Active-session denial and rollback |
| `SC-13` | Daemon-owned summary/index | `SC-11`, `SC-12` | Writer/catalog | Single-authority source scan |
| `SC-14` | Old registry removal | `SC-08`–`SC-13` | Core/all surfaces | No production callers/writers |
| `SC-15` | Architecture/docs/release closure | `SC-14` | Docs/gates | Full exit gate and migration report |

Only tasks without a dependency edge may run in parallel. Shared compatibility adapters and protocol
types must not be edited concurrently without explicit ownership.

---

## 16. Expected file impact

### 16.1 New production files

Expected under the final Core placement:

- session-catalog wire types and strict decoder;
- endpoint and metadata helpers;
- detached project-server entrypoint;
- connection/election/reconnect client;
- SQLite schema/store/rebuild implementation;
- remote registry/catalog compatibility adapters;
- presence bounding/scrubbing helpers;
- catalog-specific errors and health types.

### 16.2 Existing production files likely to change

| Area | Files or families | Intended change |
|---|---|---|
| Core registry | `packages/core/src/session-registry*.ts` | Delegate, deprecate, then remove file authority |
| Core store | `packages/core/src/storage/session-store.ts` | Split local writer/content behavior from remote catalog behavior |
| Core writer | `packages/core/src/storage/file-session-writer.ts` | Coarse catalog notifications; later daemon-owned summary commit |
| Core paths | `packages/core/src/utils/wstack-paths.ts` | Catalog/metadata paths if not derived internally |
| Core exports/build | package barrels, build entrypoints, package files | Ship project-server and public client types |
| Runtime | `packages/runtime/src/container.ts` | Bind remote adapters and remove global registry delete guard |
| CLI boot | `packages/cli/src/boot/tui-session-resume.ts`, project switch, session wiring | Claim/reservation lifecycle |
| CLI commands | session/rewind/doctor/diag handlers | Remote catalog and maintenance operations |
| WebUI server | backend services, session API handlers, fleet broadcaster | One shared client + subscriptions |
| HQ | project discovery, session routes, local history helpers | Aggregate project daemons; preserve remote telemetry |
| TUI/WebUI/SimpleUI | health and outage presentation | Surface degraded/offline catalog state |
| Architecture gates | project-daemon boundary and entrypoint tests | Add Session Catalog bidirectional ratchet |

This table is a planning inventory, not authorization for broad edits. Each implementation slice must
re-read the current tree and change only its task-owned paths.

---

## 17. Test and verification plan

### 17.1 Unit tests

- endpoint determinism, canonicalization, protocol-version separation, Unix path length;
- strict frame decoding and unknown-field rejection;
- presence truncation and scrubbing;
- lease hash/proof validation and PID/start-generation behavior;
- state transitions and idempotency;
- SQLite schema migration and transaction rollback;
- catalog row/summary conversion;
- relative-path containment;
- rebuild from modern sharded and legacy flat sessions;
- damaged JSONL/summary handling;
- cursor gap and daemon-instance reset behavior.

### 17.2 Real IPC integration tests

- fresh client launches exactly one detached owner;
- simultaneous launch election opens one SQLite database;
- unauthorized requests and shutdown are rejected;
- two clients in one project share state;
- two projects remain isolated;
- different WrongStack state roots do not collide;
- heartbeat lease survives normal scheduling jitter;
- open socket without heartbeat expires;
- slow subscriber is disconnected at the queue cap;
- idle daemon exits only after clients and leases are gone;
- stale/incompatible build is replaced or rejected according to protocol policy;
- Windows named-pipe and Unix socket cleanup behavior.

### 17.3 Ownership adversarial tests

- simultaneous explicit resume has exactly one winner;
- same PID with different start generation cannot steal ownership;
- expired reservation cannot activate;
- wrong lease proof cannot reconnect after daemon restart;
- clean release from an old generation cannot remove a replacement owner;
- `mark_closing` followed by late agent update cannot resurrect the session;
- live-but-unreachable PID stays `lost` and blocks takeover;
- dead PID is reaped after the tested grace period;
- maintenance lease and live claim exclude each other;
- force recovery requires the explicit capability/confirmation path.

### 17.4 Surface journey tests

- two TUIs start as separate fresh sessions;
- TUI resumes an inactive session;
- TUI cannot resume a session active in WebUI;
- standalone WebUI starts fresh and explicitly resumes;
- SimpleUI follows the same ownership contract;
- project switch succeeds and releases old ownership;
- failed project switch preserves the old session;
- rewind claims maintenance and releases it on every exit path;
- WebUI/HQ live lists update from subscription and recover after a gap;
- local HQ aggregates multiple projects;
- remote HQ continues receiving forwarded session telemetry;
- active delete/prune/clear/rewind actions are rejected consistently across surfaces.

### 17.5 Persistence and recovery tests

- catalog database deletion followed by rebuild preserves all valid sessions;
- summary sidecar corruption marks one row damaged without hiding unrelated sessions;
- torn/incomplete final JSONL line remains recoverable under current tolerance rules;
- ENOSPC during catalog update preserves transcript and reports degraded catalog health;
- daemon crash during rebuild leaves the previous catalog generation visible;
- daemon crash during reservation eventually expires it without creating a live owner;
- transcript truncation invalidates cached offsets and summary revision;
- large session search/list operations stay bounded.

### 17.6 Validation gates by slice

At minimum:

- focused Core/session tests;
- focused CLI lifecycle tests;
- focused WebUI-server session route and broadcaster tests;
- HQ aggregation tests where touched;
- package typechecks and declaration builds;
- project-server entrypoint/package-content tests;
- architecture boundary gate;
- Biome on changed files;
- `git diff --check` and Markdown relative-link validation;
- full `pnpm release:check` only at the final program gate or when required by the touched surface.

Test reports must distinguish focused success from whole-repository validation.

---

## 18. Observability

### 18.1 Metrics

- daemon launches, elections won/lost, reconnects, instance changes;
- active/suspect/lost/closing leases;
- claim conflicts and reservation expirations;
- heartbeat latency and missed intervals;
- presence snapshots accepted, coalesced, truncated, rejected;
- connected subscribers and slow-client disconnects;
- catalog rows, damaged rows, cache hits/misses;
- list/resolve/rebuild latency;
- SQLite transaction failures and busy time;
- bytes read during rebuild and reconciliation;
- daemon RSS, event-loop delay, handles, queue depth, uptime, idle exits.

### 18.2 Logs

Use structured, bounded, secret-free logs. Do not log raw auth tokens, lease proofs, prompts, partial
assistant text, tool inputs/outputs, mail bodies, or full transcript events.

### 18.3 Chronicle events

Persist low-volume lifecycle and correctness events, including:

- daemon health transitions;
- ownership conflict;
- forced recovery request/outcome;
- destructive maintenance start/outcome;
- catalog corruption/rebuild;
- compatibility parity drift.

Do not persist routine heartbeat or streaming presence events to Chronicle.

---

## 19. Rollout, compatibility, and rollback

### 19.1 Rollout modes

During development and migration, support explicit internal modes:

| Mode | Ownership authority | Catalog reads | Purpose |
|---|---|---|---|
| `legacy` | Global file registry | Existing store | Emergency pre-cutover rollback only |
| `shadow` | Global file registry | Existing store + daemon comparison | Parity measurement |
| `presence-primary` | Daemon | Existing catalog store | Isolate presence cutover |
| `primary` | Daemon | Daemon catalog | Final production mode |

These modes are temporary migration controls, not permanent product configuration. Remove legacy and
shadow modes when their exit criteria pass.

### 19.2 Compatibility strategy

- Keep the public `SessionRegistry` API shape while its implementation delegates to a project client.
- Add explicit project identity to constructors/factories that currently accept only `globalRoot`.
- Maintain `DefaultSessionStore` for tests and explicit inline/recovery use.
- Introduce a project-backed session-store adapter for production composition.
- Preserve existing session IDs, sharding, JSONL, summary, CAS, replay, audit, and annotation artifacts.
- Generate `_index.jsonl` temporarily only if a verified downstream consumer still requires it.
- Deprecate before removing public exports or CLI behavior.

### 19.3 Rollback by phase

- Phases 1–2: disable shadow/presence reads; old registry remains authoritative.
- Phase 3: revert the cutover release or select the explicitly shipped legacy authority while still
  inside the planned compatibility window.
- Phase 4: rebuild old index projection from JSONL/sidecars before reverting catalog reads.
- Phase 5: rollback is release-level only. Never activate old and new writable authorities together.

At no point may rollback mean silently opening one private catalog per process.

---

## 20. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Daemon becomes a new single point of failure | Session management outage | Existing writer continues; bounded reconnect; fail closed for ownership changes; health UX |
| Two authorities survive migration | Split-brain/corruption | Shadow-first program, source ratchet, phase-specific owner declaration |
| IPC on streaming hot path | Latency and CPU regression | Keep JSONL writer local; coarse notifications only |
| Lease lost on daemon restart | Duplicate resume | Durable hashed reconnect proof and owner generation |
| Global HQ visibility regresses | Missing sessions | Local daemon aggregator plus existing remote telemetry forwarding |
| Presence leaks sensitive content | Local disclosure/log growth | Strict scrub/bounds, auth, no raw presence logs |
| Catalog rebuild consumes large memory | OOM/terminal stalls | Streaming shard scan, bounded concurrency, staging generation |
| Slow subscriber grows queues | Daemon memory growth | Per-client queue cap and disconnect/requery contract |
| Project switch leaves ghost ownership | False active session | Target-first switch protocol and exact-owner cleanup |
| Windows PID/rename/pipe behavior differs | Stale claims or failed cleanup | Process generation, current Windows helpers, real named-pipe integration tests |
| JSONL and catalog summary drift | Wrong listings | Revision/file identity checks, shadow parity, explicit reconciliation |
| New Core domain breaks dependency rules | Architecture gate failure | Phase 0 placement decision and DAG/layer validation before code movement |

---

## 21. Acceptance criteria

### 21.1 Implementation evidence — 2026-08-08

The primary implementation is in `packages/core/src/session-catalog/`, with production composition
through Core storage, CLI/TUI, WebUI server, and HQ. The delivered boundary keeps transcript append
local while moving shared ownership, presence, catalog mutation, maintenance admission, discovery,
and subscriptions behind authenticated project-scoped IPC.

Verification completed in this workspace:

| Evidence | Result |
|---|---|
| Core build and declaration emit | Passed |
| Core, CLI, WebUI-server, and Runtime typechecks | Passed |
| Full affected test matrix (`packages/core/tests`, `packages/cli/tests`, `packages/webui-server/tests`) | Passed with exit code 0 |
| Real detached dist smoke test | Passed: create/catalog/claim/health/shutdown |
| Concurrent claim test | 16 contenders, exactly one winner in 8.923 ms |
| IPC latency | 100 pings: p50 0.163 ms, p95 0.356 ms, max 0.548 ms |
| Connected-client resource sample | 16 clients: 72.27 MiB RSS, 7.29 MiB heap, 17 handles |
| Filesystem authority check | Metadata plus SQLite/WAL/SHM only; no global registry write |
| Formatting and whitespace validation | Passed on task-owned paths |
| Canonical `pnpm release:check` | Passed with exit code 0, including full coverage |
| Architecture health | Passed after classification, API snapshot, usage, and hotspot synchronization |
| SAGE compatibility follow-up | Corrected the new `SageKind` taxonomy mappings; typecheck/build and 819 tests passed |
| WebUI coverage compatibility | Migrated duplicate legacy registry fixtures and added all locale labels; 42 focused tests passed |

The final repository gate completed successfully after reconciling the concurrent SAGE taxonomy,
WebUI coverage fixtures, localization catalog, and architecture ratchets with the new project-scoped
session authority.

The project is complete only when all of the following are true:

- [x] One detached Session Catalog owner exists per canonical project/state root.
- [x] The owner binds its endpoint before opening catalog SQLite.
- [x] Production clients fail closed when the built owner cannot be used.
- [x] Session JSONL remains the conversation authority and current files remain readable.
- [x] Fresh sessions remain the default for every surface.
- [x] Explicit resume uses a two-phase reservation and exactly one concurrent requester wins.
- [x] A failed resume/project switch preserves the previous live identity.
- [x] Daemon restart preserves ownership through lease proof and generation checks.
- [x] Live, reserved, or maintenance-owned sessions cannot be destructively mutated incorrectly.
- [x] Heartbeats no longer rewrite a device-global session registry.
- [x] WebUI/HQ use shared project clients instead of constructing registries per route.
- [x] Local HQ aggregates live sessions across project daemons.
- [x] Remote HQ telemetry continues to work without direct remote daemon access.
- [x] Presence, frames, queues, pages, and caches are explicitly bounded.
- [x] Slow clients are disconnected and recover through snapshot reread.
- [x] Catalog SQLite can be rebuilt from JSONL and summary artifacts.
- [x] No production process outside the owner mutates shared catalog/index state.
- [x] `~/.wrongstack/session-registry.json` is no longer a production authority.
- [x] The project-daemon architecture test guards Session Catalog in both directions.
- [x] Focused tests, package builds/typechecks, formatting, link checks, and final release gate pass.
- [x] Architecture and troubleshooting documentation describe the final current behavior.
- [x] Final measurements report latency, filesystem work, RSS, handles, and contention against the
      Phase 0 baseline.

---

## 22. Review decisions requested

The following decisions should be approved before Phase 1 implementation:

1. **Hybrid writer boundary:** keep per-session JSONL append local for the first release.
2. **Catalog role:** SQLite is rebuildable acceleration and lease authority, not replacement
   transcript content storage.
3. **Project identity:** endpoint derives from canonical `projectDir`, including WrongStack state root.
4. **Resume model:** use reserve → hydrate/open → activate, not a single eager identity swap.
5. **Restart continuity:** persist a lease-secret hash and require proof on reconnect.
6. **HQ model:** local aggregation probes project daemons; remote HQ receives forwarded projections.
7. **Module placement:** implement in a neutral Core session-catalog domain, not CLI/WebUI.
8. **Failure policy:** active writers may continue during daemon reconnect, but claims and destructive
   operations fail closed.
9. **Migration policy:** dual publication is temporary and parity-gated; no indefinite dual authority.
10. **Optional Phase 6:** transcript read/search centralization requires fresh performance evidence.

Unless review changes one of these, they are the recommended implementation defaults.

---

## 23. Source evidence map

| Current behavior | Primary source |
|---|---|
| Device-global registry, heartbeat, ownership, stale pruning | `packages/core/src/session-registry.ts` |
| Registry record and bounded agent presence shapes | `packages/core/src/session-registry-types.ts` |
| Atomic registry file/lock behavior | `packages/core/src/session-registry-atomic-file.ts` |
| Session list/load/resume/index/rename/delete/prune | `packages/core/src/storage/session-store.ts` |
| Buffered JSONL writer and close-time summary/index callback | `packages/core/src/storage/file-session-writer.ts` |
| Runtime store/delete guard wiring | `packages/runtime/src/container.ts` |
| CLI ownership and graceful shutdown wiring | `packages/cli/src/wiring/session-registry.ts` |
| TUI explicit resume | `packages/cli/src/boot/tui-session-resume.ts` |
| TUI project switch | `packages/cli/src/boot/tui-project-switch.ts` |
| Rewind temporary ownership | `packages/cli/src/subcommands/handlers/rewind.ts` |
| WebUI session and presence routes | `packages/webui-server/src/server/http-server/api-handlers.ts` |
| WebUI live-session broadcaster | `packages/webui-server/src/server/setup-events-fleet-broadcaster.ts` |
| HQ session reads and history routing | `packages/cli/src/hq-server/routes/session-handlers.ts` |
| Canonical project/state paths | `packages/core/src/utils/wstack-paths.ts` |
| Existing daemon endpoint/auth patterns | `packages/core/src/coordination/mailbox-project-server-*.ts` |
| Project-daemon architectural ratchet | `packages/core/tests/architecture/project-daemon-boundary.test.ts` |

Re-read these files at the start of each implementation phase. This plan records the 2026-08-08
source state and must not be treated as a substitute for current call-site verification.
