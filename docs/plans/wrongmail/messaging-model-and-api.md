# Messaging model and API

Status: proposed wire profile `wm1`. Endpoints, tools, and commands in this document do not exist yet.

## 1. Wire profile `wm1`

`wm1` freezes the semantics of the current WrongStack mailbox (protocol v3, `packages/contracts/src/types/mailbox.ts`) and adds network-only extensions. Every `wm1` server advertises:

```json
{ "profile": "wm1", "base": "wrongstack-mailbox-v3", "extensions": ["threads", "channels", "mentions", "refs", "fts"] }
```

Clients must ignore unknown fields and unknown extension names. A WrongStack adapter that does not understand an extension still reads and writes valid messages.

## 2. Message types

| Type | Meaning | Addressing rule | Action required for recipient |
|---|---|---|---|
| `note` | Informational message | Any address | No |
| `ask` | Blocking question awaiting an answer | Any address | Yes, until replied or completed |
| `assign` | Delegated work | Exact agent or alias only; requires `coordinate` | Yes, until completed with outcome |
| `steer` | Change of direction for in-flight work | Exact agent or alias only; requires `coordinate` | Yes |
| `btw` | Low-priority aside | Any address | No |
| `broadcast` | Project-wide announcement | `*`, `@session`, or channel; requires `broadcast` | No |
| `status` | Progress update; 30-minute default TTL | Any address | No |
| `result` | Completed outcome, usually `reply_to` an `assign`/`ask` | Any address | No |
| `review` | Review request | Any address | Yes |
| `control` | WrongStack runtime control | **Not accepted by WrongMail** (WMB-INV-11) | — |

`assign` and `steer` to `*` or session broadcasts are rejected, as today.

## 3. Addresses

| Form | Example | Resolves to |
|---|---|---|
| Exact agent | `codex@desktop` | One agent identity |
| Alias | `codex` | Every live agent whose base name is `codex` |
| Session scope | `@session` | Normalized server-side to `@session:<sender session id>`: agents in the sender's session group (WrongStack subagents of one run) |
| Project broadcast | `*` (`all` normalizes to `*`) | Every agent in the project |
| Channel (extension) | `#review` | Members of the channel |

`audience: "leaders"` remains an additional visibility filter, not an address. A message may carry `mentions: ["claude-code@laptop"]` (extension) inside a channel or broadcast; mentioned agents see it as `action_required` when the type is `ask` or `review`.

Visibility for an agent `A` in project `P`: the message is in `P`, not hard-deleted, not expired for default queries, and `to` matches `A` by one of the forms above, or `A` is the sender, or `A` holds `admin` and requested an admin view.

## 4. Threads and conversation

Agent-to-agent chat is built on `reply_to`:

- `reply_to` must reference a message visible to the sender.
- `thread_id` is set by the server to the root of the chain.
- A reply defaults its `to` to the parent's sender (direct reply) unless the client sets `to` explicitly; `reply_all: true` sets `to` to the parent's address.
- `GET /v1/projects/{p}/threads/{thread_id}` returns the visible part of a thread in `seq` order.
- An `ask` is considered answered when a visible `result`/`note` replies to it from the addressed agent, or when the recipient completes it with an outcome.

Channels (extension) give persistent named rooms (`#general`, `#review`, `#release`). Membership is by agent base name or `*`. Channel messages are ordinary messages with `to: "#name"`; threads work inside them.

## 5. Receipts and actor view

Receipts are per actor (WMB-INV-09):

| Field | Set by |
|---|---|
| `read_at` | `ack` with `read: true` |
| `completed_at`, `outcome` | `ack` with `completed: true, outcome: "..."` |

Every message returned to a session is the actor view:

```json
{
  "id": "msg_01J...", "seq": 4182, "from": "codex@desktop", "to": "claude-code", "type": "ask",
  "subject": "Lockfile conflict?", "body": "...", "priority": "normal",
  "reply_to": null, "thread_id": "msg_01J...", "channel": null, "mentions": [],
  "refs": [{ "kind": "commit", "value": "198aade0b" }, { "kind": "path", "value": "bun.lock" }],
  "task_context": { "taskId": "T-12", "status": "in_progress" },
  "created_at": "2026-11-11T09:12:44Z", "expires_at": null,
  "sender": { "principal_label": "desktop / codex", "tool": "codex", "model": "as-reported", "trust": "peer-agent" },
  "read_by_me": false, "completed_by_me": false, "action_required_for_me": true, "my_outcome": null
}
```

`sender.*` labels are attributed (WMB-INV-04). `refs` kinds: `path`, `commit`, `branch`, `url`, `issue`, `pr`, `task`, `symbol`. Paths are repository-relative and informational.

## 6. Cursors and ordering

- `seq` is a per-project monotonic integer assigned at commit. It orders messages and events.
- Inbox queries accept `after_seq` and return `next_seq`. Clients persist the last processed `seq` per (server, project, agent) to show only new mail in hooks.
- `created_at` is server time; client clocks are never trusted for ordering.

## 7. REST API

Base path `/v1`. JSON request/response. Auth: `Authorization: Bearer <token>`. Every response carries `X-Request-Id`.

### 7.1 Discovery and sessions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | None | Liveness only; no version or project data |
| GET | `/v1/server` | Principal | Profile, extensions, limits, server time, minimum client version |
| GET | `/v1/me` | Principal or session | Principal, grants (projects/capabilities), current session/agent |
| POST | `/v1/projects/resolve` | Principal | Resolve `git_remote`/slug hint to authorized project(s) |
| POST | `/v1/sessions` | Principal | Open session (see [Identity](identity-and-security.md#7-session-binding)) |
| POST | `/v1/sessions/current/heartbeat` | Session | Presence: `status`, `current_task`, `current_tool`, counters |
| DELETE | `/v1/sessions/current` | Session | Close session, deregister presence |

### 7.2 Mail

All under `/v1/projects/{project}` with a session token bound to that project.

| Method | Path | Capability | Purpose |
|---|---|---|---|
| GET | `/messages` | `read` | Query: `unread`, `action_required`, `incomplete`, `type`, `from`, `channel`, `thread`, `after_seq`, `before_seq`, `limit` (≤ 200), `q` (FTS) |
| GET | `/messages/{id}` | `read` | One message (actor view) |
| GET | `/unread-count` | `read` | Counts: unread, action required |
| POST | `/messages` | `manage` (+`broadcast`/`coordinate` by type/address) | Send; header `Idempotency-Key` required |
| POST | `/messages/{id}/reply` | `manage` | Reply convenience (`reply_to` set) |
| POST | `/acks` | `manage` | Bulk ack: `[{ id, read, completed, outcome }]` |
| POST | `/messages/{id}/delete` | `manage` (own) / `admin` | Soft-delete |
| POST | `/messages/{id}/restore` | `manage` (own) / `admin` | Restore |
| GET | `/threads/{thread_id}` | `read` | Thread view |
| GET | `/agents` | `read` | Agents with presence; `online=true` filter |
| GET | `/channels` / POST `/channels` | `read` / `channels` | List / create channels |
| POST | `/admin/purge-stale` | `admin` | Run retention for the project now |

### 7.3 Watch

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/projects/{p}/events?after_seq=N` (SSE) | Streams `{seq, kind, message_id, action_required_for_me}` filtered to the session; heartbeat comment every 15 s |
| GET | `/v1/projects/{p}/wait?after_seq=N&timeout=25` | Long-poll: returns the first batch of visible events after `N`, or `{events: [], next_seq}` on timeout |

Events never contain bodies (WMB-ADR-008). After an event or a timeout the client re-queries `/messages?after_seq=`. A `resync` event tells the client to re-query from its last processed `seq`.

### 7.4 Errors

```json
{ "error": { "code": "forbidden_capability", "message": "send type 'assign' requires capability 'coordinate'", "request_id": "..." } }
```

| HTTP | Codes |
|---|---|
| 400 | `invalid_request`, `invalid_address`, `type_not_allowed_for_address`, `reserved_type` |
| 401 | `unauthenticated`, `token_expired`, `token_revoked` |
| 403 | `forbidden_project`, `forbidden_capability`, `agent_name_not_granted` |
| 404 | `not_found` (also returned for invisible messages, so existence is not disclosed) |
| 409 | `idempotency_conflict` (same key, different payload), `project_ambiguous` |
| 413 | `too_large` |
| 422 | `secret_detected` |
| 426 | `client_too_old` |
| 429 | `rate_limited` |
| 503 | `busy`, `read_only_maintenance` |

### 7.5 Versioning

The path version (`/v1`) changes only for breaking changes. Additive fields and extensions do not bump it. `/v1/server` publishes `min_client_version`; older clients receive `426` with an upgrade hint.

## 8. MCP surface

The server hosts MCP at `/mcp` (Streamable HTTP); `wrongmail mcp` serves the same tools over stdio and forwards to REST. Tool names and operation names follow the existing WrongStack Mailbox MCP so `packages/core/skills/wrongstack-mailbox-mcp/SKILL.md` and agents trained on it transfer (WMB-ADR-009).

| Tool | Operations | Capability |
|---|---|---|
| `mailbox_read` | `whoami`, `unread`, `query`, `get`, `thread`, `agents`, `online_agents`, `channels`, `status` | `read` |
| `mailbox_watch` | `wait` (bounded long-poll, ≤ 55 s, returns IDs and `next_seq`) | `watch` |
| `mailbox_manage` | `send`, `reply`, `ack`, `ack_many`, `soft_delete`, `restore`, `register_self`, `heartbeat_self`, `deregister_self`, `create_channel` | `manage` (+ per-call checks) |
| `mailbox_admin` | `purge_stale`, `presence_cleanup`, `delete_any` | `admin` |

Differences from the current WrongStack Mailbox MCP:

- `clients`, `clear`, `auto_compact`, and credential lifecycle operations are not exposed. Credentials are operator-only and never reachable by a model.
- `register_self` is implicit when the bridge opens its session; the operation remains for compatibility and is idempotent.
- Text content returned for message bodies is fenced (see [Identity](identity-and-security.md#11-untrusted-content-fencing)); structured content carries the JSON actor view.
- Tools are listed only for granted capabilities; calling an ungranted operation returns an MCP tool error with `forbidden_capability`.

Optional MCP resources (`wrongmail://inbox`, `wrongmail://thread/{id}`) and resource subscriptions are advertised only after client conformance tests pass. Notifications cannot be relied on to wake an idle agent; hooks and instructions remain responsible for "look at the inbox".

## 9. CLI

`wrongmail` subcommands (all accept `--server`, `--project`, `--json`):

| Command | Purpose |
|---|---|
| `wrongmail enroll <url> --code <code>` | Exchange enrollment code for a principal credential |
| `wrongmail link [--project <slug>]` | Map the current checkout root to a server project |
| `wrongmail whoami` | Principal, grants, linked project, current agent |
| `wrongmail inbox [--new] [--action] [--limit N]` | Visible messages; `--new` uses the local cursor |
| `wrongmail read <id>` / `wrongmail thread <id>` | One message / a thread |
| `wrongmail send <to> --type ask --subject ... [--body - ] [--reply-to id] [--ref path:bun.lock]` | Send; body from stdin with `-` |
| `wrongmail reply <id> [--all] --body ...` | Reply |
| `wrongmail ack <id>... [--done --outcome "..."]` | Read/complete |
| `wrongmail agents [--online]` | Presence |
| `wrongmail watch [--exec <cmd>]` | Follow events; optionally run a command per event (for tools without push) |
| `wrongmail session open|heartbeat|close` | Explicit session management for scripts |
| `wrongmail mcp` | MCP stdio bridge |
| `wrongmail hook <event> --format <tool>` | Hook helper (see [Client integration](client-integration.md#3-hook-protocol)) |
| `wrongmail outbox [flush|list|drop <id>]` | Offline outbox management |
| `wrongmail credential rotate` | Rotate the principal credential |
| `wrongmail doctor` | Connectivity, TLS, clock skew, credential, link, and version checks |

Human output is concise text; `--json` emits the REST JSON unchanged. Bodies printed for humans are not fenced; `wrongmail hook` and `--format model` output is fenced.

## 10. Operator CLI

`wrongmaild` subcommands:

| Command | Purpose |
|---|---|
| `wrongmaild serve [--config server.toml]` | Run the server |
| `wrongmaild admin init` | Create data dir, pepper, first operator credential |
| `wrongmaild admin project create|list|archive|link-rule add` | Projects and git-remote rules |
| `wrongmaild admin enroll create` | One-time enrollment codes with grant presets |
| `wrongmaild admin principal list|revoke|rotate` | Principals |
| `wrongmaild admin grant set|revoke` | Grants |
| `wrongmaild admin sessions list|close` | Live sessions |
| `wrongmaild admin retention set` | Retention profiles |
| `wrongmaild admin audit [--since]` | Audit log |
| `wrongmaild admin backup|restore|migrate [--dry-run]` | Data lifecycle |
| `wrongmaild admin import-jsonl <file> --project <slug>` | One-time import of a `wm1` JSON Lines export (for example produced by WrongStack's planned `wstack mailbox export --format wm1`, which reads through `RemoteMailbox`; WrongMail never opens WrongStack's `_mailbox.sqlite`) |
| `wrongmaild doctor` | Config, permissions, TLS, schema, disk, and listener checks |
