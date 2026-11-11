# Architecture and storage

Status: proposed. Binaries, crates, paths, and numbers in this document do not exist yet.

## 1. Components

```text
                     ┌───────────────────────── wrongmaild (one process) ─────────────────────────┐
                     │                                                                             │
 Coding tool A ──MCP stdio──► wrongmail mcp ─┐                                                     │
 Coding tool B ──hook──────► wrongmail hook ─┼─HTTPS/JSON──► API layer (axum)                      │
 Shell / script ───────────► wrongmail CLI ──┘    │          ├─ auth: principal → grant → session  │
 Coding tool C ──MCP Streamable HTTP──────────────┘          ├─ REST /v1/*                         │
 WrongStack ──mailbox-port adapter──HTTPS────────────────────┤  watch (SSE / long-poll)            │
                                                             ├─ MCP endpoint /mcp                  │
                                                             ▼                                     │
                                          service layer (one method set)                           │
                                                             │                                     │
                              ┌──────────────────────────────┼──────────────────────┐              │
                              ▼                              ▼                      ▼              │
                   registry writer actor          project writer actor (×N)    event hub          │
                   registry.sqlite                projects/<id>/mail.sqlite    (in-memory fanout)  │
                     └─────────────────────────────────────────────────────────────────────────────┘
```

| Component | Binary | Responsibility |
|---|---|---|
| Server | `wrongmaild` | HTTP API, MCP endpoint, auth, storage ownership, events, retention, operator commands |
| Client | `wrongmail` | CLI, MCP stdio bridge, hook helper, enrollment, project linking, offline outbox |
| Contracts | crate `wrongmail-proto` | DTOs, JSON Schemas, error codes, wire profile constants; shared by both binaries and exported as JSON Schema/TypeScript types for the WrongStack adapter |
| Storage | crate `wrongmail-store` | SQLite schema, migrations, writer actors, readers, backup |
| Service | crate `wrongmail-core` | Authorization, addressing, visibility, receipts, idempotency, retention rules |

`wrongmaild admin ...` subcommands operate on a running server through an operator credential, or offline on a stopped data directory for backup/restore/migrate. They never open SQLite while the server runs.

## 2. Deployment modes

All modes use the same binary, protocol, and authorization. Mode only changes the listener and the TLS source.

| Mode | Listener | TLS | Typical use |
|---|---|---|---|
| D1 local | `127.0.0.1:7463` or Unix socket / Windows named pipe | None on loopback; still token-authenticated | One developer, many tools on one machine |
| D2 private network | Host interface on VPN/LAN (WireGuard, Tailscale, office LAN) | Required (built-in or proxy) | Small team or multiple personal machines |
| D3 internet-facing | Loopback behind reverse proxy (Caddy/nginx) or built-in rustls on 443 | Required | Server reachable from anywhere with credentials |

The server refuses to bind a non-loopback address without TLS unless `--insecure-plaintext-i-understand` is set, and then logs a warning on every start. Port `7463` is a placeholder pending a collision check.

There is one authoritative server per deployment. A developer who uses both a local D1 server and a remote D3 server has two separate deployments; v1 does not federate them. A project is linked to exactly one deployment at a time.

## 3. Tenancy and identity model

```text
deployment (one wrongmaild)
 ├─ operators            human admins; hold operator credentials
 ├─ principals           one per enrolled tool installation (e.g. "laptop-ersin / claude-code")
 │    └─ grants          principal × project × capability set × agent-name pattern
 └─ projects             prj_<ulid>, slug, display name, link rules
      ├─ sessions        ses_<ulid>: one live run of one tool, bound to one principal and one agent
      ├─ agents          stable agent IDs inside the project (name@tag), presence, role
      ├─ messages        addressed mail, threads, channels
      ├─ receipts        per message × per actor
      └─ events          monotonic seq outbox for watch/cursor
```

Details of principals, grants, and session binding are in [Identity and security](identity-and-security.md). There is no workspace/organization layer in v1; a deployment is one trust domain. A later `workspace` prefix is reserved in IDs and URLs (`/v1/projects/{project}` stays unique per deployment).

## 4. Storage layout

```text
<data-dir>/                     default /var/lib/wrongmail (Linux service), per-user data dir otherwise
  registry.sqlite               operators, principals, credentials, grants, projects, link rules, audit
  projects/
    prj_01J.../mail.sqlite      messages, receipts, agents, sessions, events, idempotency, channels
  backups/                      online backup output (operator command)
  server.toml                   non-secret configuration
  secrets/                      mode 0700: server pepper, TLS key if built-in TLS
```

Why per-project files: write isolation (a noisy project cannot stall another's writer), cheap project export/deletion, and bounded blast radius for corruption. Cross-project queries are operator-only (counts, audit) and go through the registry.

Every database opens with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;   -- FULL for registry.sqlite (credentials, grants)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 4.1 Registry schema (version 1)

| Table | Key columns |
|---|---|
| `meta` | `schema_version`, `created_at`, `server_id` |
| `operators` | `id`, `name`, `created_at`, `disabled_at` |
| `principals` | `id` (`pr_<ulid>`), `label`, `kind` (`tool`, `adapter`, `operator`), `created_by`, `created_at`, `disabled_at` |
| `credentials` | `id` (`cr_<ulid>`, public lookup part), `principal_id`, `hash` (HMAC-SHA-256 with server pepper), `kind` (`enroll`, `principal`, `operator`), `scopes`, `expires_at`, `rotated_from`, `revoked_at`, `last_used_at` |
| `projects` | `id` (`prj_<ulid>`), `slug` (unique), `display_name`, `created_at`, `archived_at`, `retention_profile` |
| `project_link_rules` | `project_id`, `kind` (`git_remote`, `wrongstack_project`, `explicit`), `pattern` (normalized), `created_by` |
| `grants` | `principal_id`, `project_id`, `capabilities` (set), `agent_name_pattern`, `max_sessions`, `expires_at` |
| `audit_log` | append-only: `seq`, `at`, `actor` (principal/operator), `action`, `target`, `result`, `client_ip`, `request_id`; no bodies, no secrets |

### 4.2 Project schema (version 1)

| Table | Purpose |
|---|---|
| `meta` | Schema version, wire profile, legacy-import markers |
| `agents` | `agent_id` (`name@tag`), `base_name`, `role`, `principal_id`, `display_label`, `tool_label`, `model_label`, `status`, `current_task`, `current_tool`, `last_seen_at`, `registered_at`, `deregistered_at` |
| `sessions` | `id`, `principal_id`, `agent_id`, `token_hash`, `tool_label`, `host_label`, `checkout_hint` (hashed), `branch_label`, `opened_at`, `expires_at`, `closed_at` |
| `messages` | `id` (`msg_<ulid>`), `seq`, `from_agent`, `from_session`, `from_principal`, `to`, `audience`, `type`, `subject`, `body`, `priority`, `reply_to`, `thread_id`, `channel`, `refs` (JSON), `task_context` (JSON), `session_affinity` (JSON), `created_at`, `expires_at`, `deleted_at`, `deleted_by` |
| `receipts` | `message_id`, `actor_id`, `read_at`, `completed_at`, `outcome`; primary key (`message_id`, `actor_id`) |
| `events` | `seq` (monotonic per project), `at`, `kind` (`sent`, `acked`, `deleted`, `restored`, `presence`), `message_id`, `actor_id`, visibility snapshot (`to`, `audience`, `channel`) used to filter watch delivery |
| `idempotency` | `principal_id`, `key`, `message_id`, `created_at`; unique (`principal_id`, `key`); 24 h retention |
| `channels` | `name`, `topic`, `created_by`, `created_at`, `archived_at` (extension, see messaging doc) |
| `channel_members` | `channel`, `agent_base_name` or `*` |
| `messages_fts` | Optional FTS5 over `subject`, `body` (external content); feature-flagged |

`thread_id` is the root message ID of a `reply_to` chain, materialized on insert so a thread read is one indexed query.

## 5. Concurrency model

- One writer actor per open database: a dedicated OS thread owning a single `rusqlite::Connection`, fed by a bounded `tokio::sync::mpsc` queue. Each command executes in one transaction and replies through a oneshot channel.
- A small read-connection pool per database for queries, opened read-only (`SQLITE_OPEN_READ_ONLY`), with WAL snapshots.
- Project actors start lazily on first access and stop after an idle period (default 10 minutes), closing their connections. The registry actor is always running.
- Backpressure: a full writer queue returns `503 busy` with `Retry-After`; it never grows unbounded.
- Send path in one transaction: idempotency lookup → visibility/address validation → insert message → derive thread → insert `events` row → commit. The event hub is notified only after commit (WMB-INV-07).

## 6. Event hub and watch

- In-memory broadcast per project carrying `(seq, kind, message_id, visibility snapshot)`.
- Each watch subscriber is filtered by its session's agent identity and capabilities before delivery (WMB-INV-06).
- A subscriber that falls behind (bounded buffer, default 1,024 events) is sent a `resync` event with the latest `seq` and disconnected; the client re-queries with `after=<last seen seq>`. The `events` table is the durable source for catch-up; the in-memory hub is only a wake-up accelerator.
- On restart, cursors remain valid because `seq` is persisted.

## 7. Retention

The current WrongStack defaults (24-hour visibility, removal 10 minutes after every online agent read a message) assume co-resident, always-on agents. Remote agents check in occasionally: an `ask` sent on Friday must still be there on Monday, and a thread must not lose messages because its only online reader already saw them. WrongMail therefore ships a different default profile (WMB-ADR-014):

| Rule | `network` profile (default) |
|---|---|
| Sweep interval | 5 minutes, one sweep task per server |
| Explicit `expires_at` | Honored |
| `status` messages | 30-minute TTL unless another message replies to them |
| Unread mail addressed to an exact agent or alias | Kept until read by the addressed agent(s), max 30 days |
| Incomplete `ask`, `assign`, `review` | Kept until completed; after 30 days excluded from default queries (still retrievable) |
| Thread members | Retained as a unit until the whole thread is eligible |
| Completed / fully read messages | 14 days |
| Broadcast and channel messages | 14 days |
| "Read by every online agent" early removal | Disabled |
| Soft-deleted messages | Hard-deleted after 7 days |
| `events` rows | 7 days or 100,000 rows per project, whichever is larger |
| Audit log | 180 days (configurable) |

Other per-project profiles: `keep-history` (messages hard-deleted only by operator action) and `wrongstack-local` (exact current WrongStack values, for parity tests and teams that want identical behavior). Changing retention is an operator capability and is audited.

## 8. Migrations

- Schema versions are integers per database kind (`registry`, `project`). Migrations are forward-only SQL files embedded in the binary.
- Before migrating, the server takes an online backup to `backups/pre-migrate-<version>-<timestamp>/`.
- A database with a newer schema version is opened read-only for diagnostics and refused for service (WMB-INV-15).
- `wrongmaild admin migrate --dry-run` reports the plan without mutating.
- Downgrade is by restoring the pre-migrate backup; there are no down-migrations.

## 9. Resource limits (planned defaults)

| Limit | Default |
|---|---|
| Request body | 256 KiB |
| Message body | 64 KiB UTF-8 |
| Subject | 200 characters |
| `refs` entries | 32 |
| Watch connections per session | 2 |
| Sessions per principal per project | 8 (grant-configurable) |
| Long-poll timeout | 25 s (max 55 s) |
| Request timeout | 30 s |

## 10. Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| Postgres/Redis/Supabase | User directive: SQLite owned by the service; no external database to operate |
| One database for all projects | Shared writer contention and blast radius |
| WebSocket as the only push channel | SSE and long-poll work through more proxies and from shell scripts; WebSocket can be added later |
| Separate MCP-only server | Two protocols to secure; MCP is a projection of REST service methods |
| Client-side direct SQLite (shared network filesystem) | Breaks single ownership and corrupts under network filesystems |
| Running the existing TypeScript project server remotely | Bound to local paths and Node/Bun runtime; does not meet remote auth requirements |
