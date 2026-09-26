# `wstack --hq` — HQ Command Center

`wstack --hq` starts a local **HQ command center**: a single
HTTP+WebSocket process that listens on one port and serves the
**`@wrongstack/webui-hq` React dashboard** at `/` (with a self-contained
inline-HTML fallback when the panel dist is unbuilt). The dashboard
aggregates telemetry from every WrongStack client (CLI/REPL, TUI, WebUI,
SimpleUI, and Desktop) that connects to the same URL, and
can steer/abort/spawn on connected clients through the control plane.

**Same-machine clients need zero configuration.** Every WrongStack client
starts in *auto-discovery* mode by default: it watches
`<dataDir>/runtime.json` and attaches by itself — with the client token HQ
minted on its first run — whether the HQ was already running, starts
*after* the client, or restarts on a different port. Telemetry published
while no HQ is up queues in a bounded buffer and flushes on attach. Opt out
with `WRONGSTACK_HQ_ENABLED=0`, config `hq.enabled: false`, or `/hq off`.

HQ is **project-independent**: it does not require a project root, reads no
project state, and stores no per-project data. It simply renders what
clients publish.

Observation is the default posture, but HQ is **not** read-only anymore:
the control plane (browser → client `steer` / `btw` / `queue` / `abort` /
`spawn` / `broadcast` / gated `run-command`, plus zero-client
`/api/mailbox-send`) shipped with Phases 3–4. See
[Control plane](#control-plane).

## Usage

| Command | Effect |
|---|---|
| `wstack --hq` | Start HQ on the default host/port (`0.0.0.0:3499`; local dashboard URL uses `127.0.0.1`) |
| `wstack --hq --host 0.0.0.0` | Listen on all interfaces (LAN/VPS access) |
| `wstack --hq --port 4000` | Override the default port |
| `wstack --hq --strict-port` | Fail (exit non-zero) if the requested port is busy instead of auto-advancing |
| `wstack --hq --open` | Auto-open the dashboard in the user's default browser after the server starts |
| `wstack --hq --password <value>` | Set or rotate the password-backed browser login |
| `wstack --hq --tunnel --password <value>` | Bind HQ to loopback and publish a temporary `*.trycloudflare.com` HTTPS URL |
| `wstack hq` | Equivalent to `wstack --hq` (subcommand form) |
| `wstack hq serve` | Same as `wstack hq` (explicit form) |
| `wstack hq token create [label]` | Mint a browser token (enters TOKEN MODE), write to `<dataDir>/auth.json` |
| `wstack hq token create --client [label]` | Mint a least-privilege client token for `/ws/client` enrollment |
| `wstack hq token create --client --capabilities telemetry.publish,control.execute [label]` | Mint a client token that may receive the separately operator-enabled `run-command` flow |
| `wstack hq token list` | List issued browser tokens (`ls` alias works) |
| `wstack hq token list --client` | List issued client tokens (Phase 4) |
| `wstack hq token revoke <id>` | Revoke a browser token (id prefix match; `rm`/`remove` aliases work) |
| `wstack hq token revoke --client <id>` | Revoke a client token (Phase 4) |

The handler short-circuits the normal `boot()` flow, so `--hq` works without
a valid project root or `.wrongstack/` directory.

### First-run setup

On first run, when `<dataDir>/auth.json` is missing, HQ automatically creates
one browser token and one client token. On every startup, HQ prints the browser
URL and client WebSocket URL; when tokens exist in `auth.json`, those URLs are
tokenized. Same-machine clients need **no** configuration at all: auto-discovery
is on by default, and clients auto-load the first client token
from `<dataDir>/auth.json` unless `WRONGSTACK_HQ_TOKEN` is explicitly set.
Existing `auth.json` is treated as operator intent, including empty token arrays
for open mode.

HQ also writes `<dataDir>/runtime.json` with the actual bound URL after startup.
Same-machine clients use it when no explicit `WRONGSTACK_HQ_URL` or config URL is
set, so custom ports and non-strict auto-advanced ports are discoverable. The
marker is removed on clean shutdown and ignored when its recorded process is no
longer alive. Clients re-read the marker before every connect attempt (and on a
fixed dormant poll while no HQ is up), so an HQ started later or restarted on a
new port is picked up without restarting any client.

Once running, the URLs the browser and clients should use are printed to stdout,
e.g.:

```text
WrongStack HQ listening on http://127.0.0.1:3499
Browser endpoint: http://127.0.0.1:3499/?token=<browser-token>
Client endpoint:  ws://127.0.0.1:3499/ws/client?token=<client-token>

First-run HQ auth created in C:\\Users\\you\\.wrongstack\\hq
Start clients with:
  WRONGSTACK_HQ_URL=http://127.0.0.1:3499
  WRONGSTACK_HQ_TOKEN=<client-token>
```

## Flags

All flags are parsed by the unified `parseArgs()` in
`packages/cli/src/arg-parser.ts` and dispatched in
`packages/cli/src/cli-main.ts`.

| Flag | Form | Type | Default | Description |
|---|---|---|---|---|
| `--hq` | `--hq` | boolean | `false` | Start HQ command center instead of the normal REPL/TUI/WebUI flow |
| `--host` | `--host <ip>` or `--host=<ip>` | string | `0.0.0.0` | Bind host. Use `127.0.0.1` for local-only access |
| `--port` | `--port <n>` or `--port=<n>` | number | `3499` | Bind port. Parsed via `Number.parseInt(value, 10)`; non-numeric values fall through as `NaN` and `startHqServer` will reject the bind |
| `--strict-port` | `--strict-port` | boolean | `false` | Fail if the requested port is in use; otherwise scan forward for a free port (bounded) |
| `--open` | `--open` | boolean | `false` | Open the dashboard URL in the default browser after the server prints its listening URL. Implementation: dynamic `import('@wrongstack/webui/server')` of `openBrowser()`. Errors are best-effort and silently swallowed |
| `--data-dir` | `--data-dir <path>` or `--data-dir=<path>` | string | `~/.wrongstack/hq` | HQ data directory: where `auth.json` (and in later phases, the persistent event log + snapshot cache) live. Relative paths resolve against `process.cwd()`. The env var `WRONGSTACK_HQ_DATA_DIR` provides the same override without a CLI flag; the flag wins when both are set. The default honors `WRONGSTACK_HOME`, so pointing that at a sandbox also relocates HQ state |
| `--password` | `--password <value>` or `--password=<value>` | string | `WRONGSTACK_HQ_PASSWORD` / unset | Enable password login or rotate an existing password (minimum 8 characters). Stored only as a scrypt hash; rotation invalidates existing password sessions. Prefer the environment variable on shared machines so the secret is not present in the process command line |
| `--tunnel` | `--tunnel` | boolean | `false` | Start `cloudflared tunnel --url <loopback HQ URL>`, print the temporary HTTPS URL, and stop the tunnel with HQ. Requires `cloudflared` in `PATH`; refuses open mode/non-loopback binds. If live reload removes the final browser credential, data APIs remain authenticated and existing browser sessions/channels are revoked until authentication is restored |
| `--client` | `--client` or `-c` | boolean | `false` | Token subcommand scope selector. When passed to `wstack hq token create/list/revoke`, operates on **client tokens** (validated on `/ws/client`) instead of the default **browser tokens** (validated on `/ws/browser`). Phase 4 |
| `--capabilities` | `--capabilities <csv>` | string | scope default | Token grants. Browser tokens allow `control.enqueue`, `control.approve` (answer any tool-approval prompt, including persistent `always`/`deny`) and `control.approve.once` (one-shot `yes`/`no` and ask_user answers only — what the mobile login carries); client tokens allow `telemetry.publish` and optionally `control.execute`. New browser/client defaults are `control.enqueue` / `telemetry.publish` respectively |

`--host` and `--port` accept both forms:
- `--key=value` → `flags[name] = "value"` (parsed by the `=` branch)
- `--key value` (next arg does not start with `-`) → `flags[name] = "value"` (parsed by the positional-value branch)
- `--key` alone → `flags[name] = true` (parser falls through to boolean)

`--hq`, `--open`, `--tunnel`, `--strict-port`, and `--client` are listed in
`BOOLEAN_FLAGS`, so they never consume the positional token label that follows.
`--host`, `--port`, and `--capabilities` accept values.

### Dispatch order in `cli-main.ts`

The order of early exits in `main(argv)` (line 126) matters:

1. **`--help` / `--version` short-circuit** (line 161) — fires before any
   other dispatch. `wstack --hq --help` prints help text (which describes
   the REPL/TUI/WebUI flow, not HQ-specific behavior) and exits, NOT
   starting the HQ server.
2. **`--hq` short-circuit** (line 171) — when `--hq` is present (after the
   help/version check passes), the function dynamic-imports
   `./hq-server.js`, calls `startHqServer({ host, port, strictPort })`,
   optionally calls `openBrowser()`, and then blocks on a Promise that
   resolves only on `SIGINT` / `SIGTERM`.
3. **`boot(argv)`** (line 195) — normal project-root-aware flow (REPL /
   TUI / WebUI). Never reached when `--hq` is set.

Consequences:

- `--hq` works without a project root, `.wrongstack/`, configured provider,
  or any agent state. Run it from any directory.
- `wstack --hq --help` prints the standard help and exits without
  starting HQ. Use `wstack --hq` alone (or with `--host`/`--port`/
  `--strict-port`/`--open`) to actually start it.
-- Other flags that the HQ path ignores (e.g. `--tui`, `--webui`,
  `--recover`) are silently dropped on the HQ path because
  the dispatch never reaches `boot()`. `--director` is removed entirely — Director Mode is hard-coded on.

## HTTP routes

| Route | Method | Response | Notes |
|---|---|---|---|
| `/` | GET | `text/html` | The HQ panel: the built `@wrongstack/webui-hq` React app when its dist resolves, else the self-contained inline fallback. Static assets under `/assets/` (token-exempt). API/WS paths are never routed through the static server |
| `/api/snapshot` | GET | `application/json` (`HqSnapshot`) | Same shape the browser receives on `/ws/browser` connect (see `HqSnapshot` schema in `protocol.ts`) |
| `/api/auth/status` | GET | `application/json` | Public auth-mode metadata used to render the credential gate; contains no credentials or telemetry |
| `/api/login` / `/api/logout` | POST | `application/json` | Password session lifecycle. Login is throttled and sets a signed HttpOnly cookie; logout invalidates it |
| `/api/auth/password` | POST / DELETE | `application/json` | Create/change/remove the HQ browser password from the Security view. Password sessions must provide the current password; an authenticated browser token can recover/reset it. Local loopback open mode may bootstrap its first password. Public relay mode refuses removal of the final browser auth method |
| `/api/system/update` | GET | `application/json` | Cached npm self-update status used by the HQ warning banner. The UI polls every six hours; registry access remains capped by the existing 24-hour update cache |
| `/api/projects/:id` | GET | `application/json` (`ProjectDetail`) | Drilldown endpoint used by the project drawer |
| `/api/fleet` | GET | `application/json` (`HqSnapshot`) | Alias of the live snapshot (fleet rollup) |
| `/api/events` | GET | `application/json` `{events, total}` | Persisted event envelopes from `<dataDir>/events.jsonl`, newest first. `?limit=` (≤5000), `?type=` filter. The panel backfills Brain / Worktrees / Mailbox from here |
| `/api/trends/cost` | GET | `application/json` `{samples}` | 5-min-bucketed cost/token/tool-call time series (`HqTimeseriesSample[]`), `?since=` epoch-ms filter |
| `/api/alerts` | GET | `application/json` `{active, history}` | Alert engine state (`?limit=`, default 100) |
| `/api/projects/:projectId/kanban` | GET | `application/json` (`HqKanbanSnapshotPayload`) | Latest persisted boards and tombstones for the repository-stable project identity. Used by the read-only Kanban dashboard view |
| `/api/sessions` | GET | `application/json` | Live sessions from the cross-process `SessionRegistry` (local machine) |
| `/api/sessions/:id/events` | GET | `application/json` `{sessionId, source, total, entries}` | Full chat history for a terminal. Local sessions replay the JSONL from disk (`source:"disk"`, merged tool args+results); remote sessions serve the in-memory stream ring (`source:"stream"`). `?limit=` (≤5000, default 200), `?full=1` returns everything |
| `/api/agents/:id/messages` | GET | `application/json` | Per-subagent message ring (`?full=1`) |
| `/ws/browser` | WS upgrade | Stream of `HqBrowserMessage` frames | Browser connects here. Receives the current snapshot immediately, then live updates |
| `/ws/client` | WS upgrade | Stream of `HqClientMessage` / `HqServerMessage` frames (bidirectional) | Telemetry clients (TUI/REPL/WebUI) connect here. A live client token (`?token=`) is required whenever any client token exists **or** HQ holds any browser credential (password or browser token); only a fully credential-free HQ accepts tokenless publishers. With a password set and zero live client tokens, every publisher is rejected — mint one with `wstack hq token create --client`. Protocol version mismatch → close `1008` |
| `/api/command` | POST | `application/json` (`202` on accept) | **Control plane.** Enqueue a command to a **connected** client. Requires a browser token with `control.enqueue` (open mode allows any). Target client must advertise `control.receive`. See [Control plane](#control-plane) |
| `/api/commands` | GET | `application/json` | Recent command audit entries (`?limit=`, default 200) |
| `/api/mailbox-send` | POST | `application/json` (`202` on delivery) | **Direct mailbox write** — deliver a prompt even when **no client is connected**. Same auth as `/api/command`. See [Direct mailbox delivery](#direct-mailbox-delivery-apimailbox-send) |
| `/api/projects/:projectId/mailbox/<route>` | POST/GET | `application/json` | **Project-scoped GlobalMailbox HTTP gateway** — same wire protocol as the standalone `wstack mailbox serve` bridge (see [Shared mailbox router](#shared-mailbox-router)). `projectId` is resolved server-side via `SessionRegistry`; raw filesystem paths are **not** accepted. Requires a browser token with `control.enqueue`. `:projectId` may be the committed `proj_<ULID>`, the legacy `projectSlug`, or the `sha256(projectRoot)[:12]` stamp. See [Project-scoped mailbox gateway](#project-scoped-mailbox-gateway-apiprojectsprojectidmailboxroute) |

### Control plane

The HQ dashboard can send prompts to running agents through the
control plane. Two transports exist:

1. **`POST /api/command`** — enqueues a typed command for a **connected**
   client, drained when that client next polls (`client.command_poll`).
   Requires a live client advertising `control.receive`.
2. **`POST /api/mailbox-send`** — writes the prompt straight into the
   project mailbox, so it lands **even with zero connected clients** (see
   the next section).

Both paths ultimately deliver a message into the project mailbox, so
they inherit the agent's existing mailbox guardrails. **HQ prompts are
raw** — they are directives injected into the agent loop and bypass
prompt refinement.

#### Send types

The command `type` selects how the message reaches the target agent.
The three prompt-carrying types are:

| Type | Mailbox message type | Meaning for the receiving agent |
|---|---|---|
| `steer` | `steer` | **Change course now.** Adjust the current operation at the next stopping point. |
| `btw` | `btw` | **FYI / context.** Absorbed as information; does *not* demand a course change. |
| `queue` | `note` | **Waits its turn.** A plain note the agent picks up before its next step. |
| `broadcast` | `broadcast` | Fan out to every agent on the target's project (`to: all`). |

The full set of `HQ_COMMAND_TYPES` (see `packages/core/src/hq/commands.ts`)
also includes `abort`, `spawn`, and the gated `run-command`. Only
`steer` / `btw` / `queue` / `broadcast` write a prompt to the mailbox;
the others route through the agent's decision loop.

#### `/api/command` request

```jsonc
POST /api/command
{
  "clientId": "<connected client id>",  // required — target must be online
  "type": "steer",                       // steer | btw | queue | broadcast | abort | spawn | run-command
  "payload": {
    "to": "leader",                      // agent address; omitted for broadcast
    "subject": "HQ prompt",
    "body": "switch to plan B",
    "priority": "high"                   // low | normal | high (default normal)
  }
}
```

Responses: `202` `{ commandId, queued: true, clientId }` on accept;
`401` (bad token), `403` (token lacks `control.enqueue`), `404`
(client not connected), `409` (client lacks `control.receive`), `400`
(malformed command).

#### Direct mailbox delivery (`/api/mailbox-send`)

`/api/command` needs a live client. When the HQ screen sends a prompt to
a project that has **no connected agent** (e.g. a terminal open but no
active leader run, or nothing running at all), the dashboard falls back
to `POST /api/mailbox-send`. This writes the prompt directly into the
project's `GlobalMailbox` on disk, where the next agent to run — or any
open terminal/WebUI — picks it up.

**Target resolution is server-side and path-safe.** The browser sends a
`sessionId` (or `projectId`), never a filesystem path. The server
resolves the `projectRoot` itself via the `SessionRegistry` (by
`sessionId`, else by `projectSlug`), so the route cannot be used to
write outside projects HQ already knows about.

```jsonc
POST /api/mailbox-send
{
  "sessionId": "<session id>",   // OR "projectId": "<project slug>"
  "type": "result",              // note | ask | assign | steer | btw | queue
                                    // broadcast | status | result | review
  "to": "leader",                // agent address (default "leader"); ignored for broadcast
  "subject": "HQ prompt",
  "body": "continue please",
  "priority": "high",
  "audience": "leaders"         // all (default) | leaders
}
```

Auth mirrors `/api/command` (browser token + `control.enqueue`).
Responses:

| Status | Meaning |
|---|---|
| `202` | Delivered. Body: `{ delivered: true, messageId, to, type, audience }` (`type` is the emitted mailbox type — e.g. `queue` → `note`). |
| `400` | Missing `type`/`body`, missing both `sessionId` and `projectId`, an invalid `audience`, or an unrecognized/non-mailbox type. |
| `401` | Missing/invalid browser token (token mode). |
| `403` | Token lacks `control.enqueue`. |
| `404` | Target project mailbox could not be resolved from the registry. |
| `500` | Mailbox write failed. |

### `/api/snapshot` response shape — `HqSnapshot`

Returns the same `HqSnapshot` value broadcast over `/ws/browser`. All fields
are always present (empty arrays when no clients are connected):

```jsonc
{
  "generatedAt": "2026-06-21T10:00:00.000Z",
  "clients":   [],  // HqClientRecord[]
  "projects":  [],  // HqProjectRecord[]
  "sessions":  [],  // HqSessionSummary[]
  "fleets":    [],  // HqFleetSummary[]
  "mailboxes": [],  // HqMailboxSummary[]
  "totals": {
    "activeProjects":            0,
    "activeClients":             0,
    "activeSessions":            0,
    "activeSubagents":           0,
    "unreadMailboxMessages":     0,
    "incompleteMailboxMessages": 0,
    "totalCostUsd":              0
  }
}
```

Per-record shapes (from `protocol.ts`):

- **`HqClientRecord`** — `clientId`, `kind` (`tui`/`repl`/`webui`/`cli`/`unknown`),
  `machineId`, optional `hostname`/`pid`/`version`, `connected` boolean,
  optional `connectedAt`, `lastSeenAt`, `projectId`, optional `sessionId`,
  `capabilities: readonly HqClientCapability[]`.
- **`HqProjectRecord`** — `projectId`, `projectName`, `projectRootDisplay`,
  `machineIds: readonly string[]`, optional `gitBranch`, `activeClients`,
  `activeSessions`, `activeSubagents`, `totalCostUsd`, `lastActivityAt`,
  `status: "active" | "idle" | "stale" | "error"`.
- **`HqSessionSummary`** — `sessionId`, `projectId`, `clientId`,
  `status: HqSessionStatus`, optional `provider`/`model`/`startedAt`,
  `lastActivityAt`, optional `costUsd`.
- **`HqFleetSummary`** — `runId`, `projectId`, `clientId`, `activeSubagents`,
  `queuedTasks`, `completedTasks`, `failedTasks`, optional `totalCostUsd`,
  `lastActivityAt`.
- **`HqMailboxSummary`** — `mailboxId`, `projectId`,
  `scope: "project" | "global"`, `messageCount`, `unreadCount`,
  `incompleteCount`, `highPriorityCount`, `onlineAgentCount`,
  `lastActivityAt`.

### `/api/projects/:id` response shape — `ProjectDetail`

Server-defined envelope (not exported as a public type from `@wrongstack/core`):

```jsonc
{
  "generatedAt": "2026-06-21T10:00:00.000Z",
  "project":     { /* HqProjectRecord — see above */ },
  "clients":     [],  // HqClientRecord[] (filtered to this project)
  "mailboxes":   []   // HqMailboxSnapshotPayload[] (FULL payloads with messages[]/agents[]/totals)
}
```

Important differences from `/api/snapshot`:

- `clients` is filtered to `projectId === :id`.
- `mailboxes` contains **full** `HqMailboxSnapshotPayload` (with `messages[]`,
  `agents[]`, and `totals`), NOT the summarized `HqMailboxSummary[]` shape
  used by `/api/snapshot`. This is intentional — the drawer needs message
  subjects and previews.
- `project` is derived from the first matching `client.hello` project identity:
  `projectName`, `projectRootDisplay`, `machineIds`, and optional `gitBranch`
  are preserved; `activeClients` = filtered client count.

### Error responses

All error responses use the WrongStack API design standard shape:

```jsonc
{ "error": { "code": "ERROR_CODE", "message": "human-readable explanation" } }
```

| HTTP | `code` | Trigger |
|---|---|---|
| `400` | `BAD_REQUEST` | `/api/projects/` (empty id) |
| `404` | `NOT_FOUND` | `/api/projects/<unknown-id>` (no client reports this project) |
| `404` | _(text/plain)_ | any other path |
| `400` | _(raw upgrade close)_ | WS upgrade to a path that is not `/ws/browser` or `/ws/client` |

`Content-Type` for JSON errors is `application/json`; for the catch-all
unknown path it is `text/plain` with the body `Not found`.

## WebSocket frames

All frame types are defined in `@wrongstack/core/hq/protocol.ts` and
re-exported via `@wrongstack/core/hq`. The discriminated unions are:

| Channel | Union | Members |
|---|---|---|
| Server → browser | `HqBrowserMessage` | `HqBrowserSnapshotMessage` (`type: "hq.snapshot"`), `HqBrowserEventMessage` (`type: "hq.event"`), `HqAlertMessage` (`type: "hq.alert"`), application heartbeat (`type: "hq.heartbeat"`) |
| Client → server | `HqClientMessage` | `HqClientHelloMessage` (`type: "client.hello"`), `HqClientEventMessage` (`type: "client.event"`), `HqClientCommandPollMessage` (`type: "client.command_poll"`), `HqClientCommandAckMessage` (`type: "client.command_ack"`) |
| Server → client | `HqServerMessage` | `HqWelcomePayload` (`type: "hq.welcome"`, sent on every `client.hello`), `HqServerCommandBatchMessage` (`type: "hq.command_batch"` — emitted when a `client.command_poll` drains the client's command queue) |

### Browser → server

The browser sends no WS frames — the `/ws/browser` channel is
receive-only. Control actions go through HTTP (`POST /api/command`,
`POST /api/mailbox-send`) instead.

### Server → browser

`hq.snapshot` — server pushes the current global state on browser connect and
after every `client.event` that changes rollup state:

```jsonc
{
  "type": "hq.snapshot",
  "snapshot": {
    "generatedAt": "2026-06-21T10:00:00.000Z",
    "clients":  [],   // HqClientRecord[]
    "projects": [],   // HqProjectRecord[]
    "sessions": [],   // HqSessionSummary[]
    "fleets":   [],   // HqFleetSummary[]
    "mailboxes":[],   // HqMailboxSummary[]
    "totals": {
      "activeProjects": 0, "activeClients": 0,
      "activeSessions": 0, "activeSubagents": 0,
      "unreadMailboxMessages": 0, "incompleteMailboxMessages": 0,
      "totalCostUsd": 0
    }
  }
}
```

`hq.event` — server forwards every `client.event` envelope from a client to
all browsers. This is what powers the drawer live feed:

```jsonc
{
  "type": "hq.event",
  "event": { /* HqEventEnvelope<TPayload> — see envelope shape below */ }
}
```

`hq.alert` — server-pushed alert from the `HqAlertEngine` (evaluates the
live snapshot every 15 s against cost / stale / concurrency / failure
rules; only cleared→firing transitions emit):

```jsonc
{
  "type": "hq.alert",
  "severity": "info" | "warn" | "error",
  "message": "human-readable text",
  "timestamp": "ISO-8601"
}
```

### Client → server

`client.hello` — MUST be the first frame on a new socket. The payload is the
nested `HqClientHelloPayload`:

```jsonc
{
  "type": "client.hello",
  "payload": {
    "protocolVersion": 1,                  // HqProtocolVersion; mismatch → close 1008
    "client": {                            // HqClientIdentity
      "clientId":  "<stable-machine:kind:pid>",
      "kind":      "tui" | "repl" | "webui" | "cli" | "unknown",
      "machineId": "<sha256(hostname:pid)[:12]>",
      "hostname":  "host.example",        // optional
      "pid":       12345,                  // optional
      "version":   "0.6.0",               // optional — WrongStack build
      "startedAt": "2026-06-21T10:00:00.000Z"
    },
    "project": {                           // HqProjectIdentity
      "projectId":   "<sha256(projectRoot)[:12]>",
      "projectRoot": "/abs/path/to/project",
      "projectName": "wrongstack-core",    // alias or basename(projectRoot)
      "machineId":   "<same as client.machineId>",
      "workspaceKind": "git" | "directory" | "unknown",
      "gitRemote":   "git@github.com:...", // optional
      "gitBranch":   "main"                // optional
    },
    "capabilities": [
      "telemetry.publish", "session.summary",
      "fleet.summary",    "mailbox.summary"
      // "control.receive" — opt-in only when client accepts server commands
    ]
  }
}
```

Server behavior:

- `payload.protocolVersion !== HQ_PROTOCOL_VERSION` → `ws.close(1008, "protocol version mismatch")`.
- Valid hello → server stores the client, replies with an `hq.welcome`
  frame on the same socket, emits a `client.hello` event envelope to all
  browsers, and broadcasts a fresh `hq.snapshot`. The welcome frame shape
  is `{ type: "hq.welcome", protocolVersion, serverTime, acceptedCapabilities, redactionPolicy }`
  — `protocolVersion` and the active redaction policy are surfaced back
  to the client so it can adapt its publish cadence / payload shape; the
  server echoes the requested `acceptedCapabilities` verbatim in Phase 1
  (no negotiation; Phase 2 will filter or reject).
- Any frame received before `client.hello` is dropped (the server tracks
  this with an internal `registered` flag).

`client.event` — every subsequent envelope from the client. Carries a full
`HqEventEnvelope<TPayload>`:

```jsonc
{
  "type": "client.event",
  "event": {
    "id":            "uuid-v4",
    "type":          "client.hello" | "client.heartbeat" | "session.started" |
                     "session.status" | "session.usage" | "tool.started" |
                     "tool.completed" | "fleet.snapshot" | "fleet.event" |
                     "mailbox.snapshot" | "mailbox.event" | "worklist.snapshot" |
                     "git.snapshot",
    "schemaVersion": 1,                    // always HQ_PROTOCOL_VERSION
    "timestamp":     "2026-06-21T10:00:00.000Z",
    "clientId":      "<same as client.hello.client.clientId>",
    "projectId":     "<same as client.hello.project.projectId>",
    "sessionId":     "sess_abc",          // optional
    "runId":         "run_xyz",           // optional
    "seq":           7,                   // monotonic per (clientId, projectId)
    "payload": { /* one of the *Payload interfaces below */ }
  }
}
```

Payload type per event type:

| `event.type` | `event.payload` shape |
|---|---|
| `client.hello` | `{ client: HqClientIdentity, project: HqProjectIdentity }` (server-emitted on hello) |
| `client.heartbeat` | `HqClientHeartbeatPayload` — `uptimeMs`, `status`, optional `activeSessionId` / `activeRunId` / `activeSubagents` / `queuedTasks` |
| `session.started` | `HqSessionStartedPayload` — `sessionId`, optional `provider`/`model`, `startedAt` |
| `session.status` | `HqSessionStatusPayload` — `status` (`idle`/`running`/`paused`/`completed`/`failed`), optional `phase`/`message` |
| `session.usage` | `HqUsagePayload` — optional `inputTokens`/`outputTokens`/`totalTokens`/`costUsd`/`durationMs` |
| `tool.started` | `HqToolStartedPayload` — `toolName`, optional `capabilities[]`/`risk`/`inputSummary` |
| `tool.completed` | `HqToolCompletedPayload` — `toolName`, `status` (`success`/`error`/`timeout`/`cancelled`), `durationMs`, optional `outputSummary`/`errorClass` |
| `fleet.snapshot` | `HqFleetSnapshotPayload` — `runId`, `activeSubagents`, `queuedTasks`, `completedTasks`, `failedTasks`, optional `totalCostUsd`, `subagents[]` |
| `fleet.event` | `HqFleetEventPayload` — `runId`, optional `subagentId`/`summary`, `event`, `data` |
| `mailbox.snapshot` | `HqMailboxSnapshotPayload` — `mailboxId`, `scope` (`project`/`global`), `messages[]`, `agents[]`, `totals` |
| `mailbox.event` | `HqMailboxEventPayload` — `mailboxId`, `action` (`message.sent`/`message.read`/`message.completed`/`message.updated`/`agent.registered`/`agent.heartbeat`/`agent.offline`), optional `message`/`agent`/`summary` |
| `kanban.snapshot` | `HqKanbanSnapshotPayload` — `projectId`, `generatedAt`, authoritative `boards[]`, and `tombstones[]` |
| `worklist.snapshot` | `HqWorklistSnapshotPayload` — optional `todos`/`tasks`/`plans` `HqWorklistCounts`, optional `activeItem` |
| `git.snapshot` | `HqGitSnapshotPayload` — optional `branch`/`dirtyFiles`/`stagedFiles`/`ahead`/`behind` |

`mailbox.snapshot` is authoritative: the server adopts it into the
per-(client, mailbox) state and immediately re-broadcasts the global
`hq.snapshot` so the browser counters reflect the latest rollup.

`client.command_poll` (Phase 2, when `control.receive` capability is set) —
client asks the server for any commands queued for it since the last poll:

```jsonc
{
  "type": "client.command_poll",
  "clientId":  "<from client.hello>",
  "projectId": "<from client.hello>",
  "afterCommandId": "cmd_abc",   // optional
  "limit":             20         // optional, default 20
}
```

`client.command_ack` (Phase 2) — client reports the outcome of an executed
command:

```jsonc
{
  "type": "client.command_ack",
  "clientId":  "<from client.hello>",
  "projectId": "<from client.hello>",
  "commandId": "cmd_abc",
  "status":    "accepted" | "completed" | "failed" | "rejected",
  "message":   "optional human-readable note"
}
```

### Server-side `parseHqFrame()` — discriminated dispatcher

The server parses every inbound frame with `parseHqFrame()` (exported
from `@wrongstack/core/hq/protocol`), which narrows to the
`HqClientMessage` union with per-type shape guards and surfaces
unrecognized frames so the server can drop them. The reference shape of
that helper:

```typescript
import type {
  HqClientMessage,
  HqClientHelloMessage,
  HqClientEventMessage,
  HqClientCommandPollMessage,
  HqClientCommandAckMessage,
} from '@wrongstack/core/hq';

export type HqParseResult =
  | { ok: true; frame: HqClientMessage }
  | { ok: false; reason: 'invalid-json' | 'unknown-type' | 'malformed' };

const KNOWN_FRAME_TYPES = new Set<HqClientMessage['type']>([
  'client.hello',
  'client.event',
  'client.command_poll',
  'client.command_ack',
]);

function hasStringType(x: unknown): x is { type: string } {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

export function parseHqFrame(raw: string | Buffer): HqParseResult {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!hasStringType(json)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!KNOWN_FRAME_TYPES.has(json.type as HqClientMessage['type'])) {
    return { ok: false, reason: 'unknown-type' };
  }

  // Per-type field validation. Discriminator narrows to the specific
  // interface so the cast below is safe and editor type-checks each branch.
  switch (json.type as HqClientMessage['type']) {
    case 'client.hello':
      if (!isHqClientHello(json)) return { ok: false, reason: 'malformed' };
      return { ok: true, frame: json };

    case 'client.event':
      if (!isHqClientEvent(json)) return { ok: false, reason: 'malformed' };
      return { ok: true, frame: json };

    case 'client.command_poll':
      if (!isHqClientCommandPoll(json)) return { ok: false, reason: 'malformed' };
      return { ok: true, frame: json };

    case 'client.command_ack':
      if (!isHqClientCommandAck(json)) return { ok: false, reason: 'malformed' };
      return { ok: true, frame: json };
  }
}

// Field-shape guards. Keep these narrow — they exist so parseHqFrame()
// can return `ok: true` only when every required field is present and
// shaped correctly.
function isHqClientHello(x: object): x is HqClientHelloMessage {
  const f = x as HqClientHelloMessage;
  return (
    f.payload !== undefined &&
    f.payload.protocolVersion !== undefined &&
    f.payload.client !== undefined &&
    f.payload.project !== undefined &&
    Array.isArray(f.payload.capabilities)
  );
}

function isHqClientEvent(x: object): x is HqClientEventMessage {
  const f = x as HqClientEventMessage;
  return (
    f.event !== undefined &&
    typeof f.event.id === 'string' &&
    typeof f.event.schemaVersion === 'number' &&
    typeof f.event.timestamp === 'string' &&
    typeof f.event.clientId === 'string' &&
    typeof f.event.projectId === 'string' &&
    typeof f.event.seq === 'number' &&
    f.event.payload !== undefined
  );
}

function isHqClientCommandPoll(x: object): x is HqClientCommandPollMessage {
  const f = x as HqClientCommandPollMessage;
  return typeof f.clientId === 'string' && typeof f.projectId === 'string';
}

function isHqClientCommandAck(x: object): x is HqClientCommandAckMessage {
  const f = x as HqClientCommandAckMessage;
  return (
    typeof f.clientId === 'string' &&
    typeof f.projectId === 'string' &&
    typeof f.commandId === 'string' &&
    (f.status === 'accepted' ||
      f.status === 'completed' ||
      f.status === 'failed' ||
      f.status === 'rejected')
  );
}
```

Usage in the WebSocket message handler:

```typescript
ws.on('message', (data) => {
  const parsed = parseHqFrame(data);
  if (!parsed.ok) {
    if (parsed.reason === 'invalid-json') {
      ws.close(1003, 'invalid frame');           // unsupported data
    } else if (parsed.reason === 'unknown-type') {
      ws.close(1008, 'unknown frame type');      // policy violation
    } else {
      ws.close(1008, 'malformed frame');         // malformed payload
    }
    return;
  }

  const frame = parsed.frame;
  switch (frame.type) {
    case 'client.hello':
      // frame is now narrowed to HqClientHelloMessage
      if (frame.payload.protocolVersion !== HQ_PROTOCOL_VERSION) {
        ws.close(1008, 'protocol version mismatch');
        return;
      }
      // ... register client, broadcast snapshot, etc.
      return;

    case 'client.event':
      // frame is HqClientEventMessage<unknown>; narrow per-event-type when
      // you care about payload shape (mailbox.snapshot vs. tool.completed, etc.)
      // ... adopt mailbox snapshots, broadcast events, etc.
      return;

    case 'client.command_poll':
    case 'client.command_ack':
      // Phase 2 control channel — ignored until auth lands.
      return;
  }
});
```

Notes:

- The guards above are intentionally **shape-only** (presence + primitive
  type checks). They do not validate nested records like
  `HqClientIdentity.machineId` or `HqEventEnvelope.payload` — keep those
  validations next to the consumers that depend on them.
- The discriminated switch on `frame.type` gives full type narrowing to
  the per-frame interface inside each branch; the runtime `as` cast on
  the parser side is gone.
- WebSocket close codes used here (`1003` unsupported data, `1008`
  policy violation) follow RFC 6455 §7.4.1.

## Browser UI

The primary dashboard is the **`packages/webui-hq` React app** (offline
Vite bundle, no CDN), served from its built `dist/` with a graceful
fallback to a self-contained inline HTML page when the dist is unbuilt.
The panel connects to `/ws/browser` and renders twelve views behind a
header (live LED + fleet stat chips) and a tab bar:

| View | Contents | Data source |
|---|---|---|
| **Cockpit** | Fleet overview, quick actions (broadcast / pause), alert + cost summaries | `hq.snapshot`, `hq.alert`, `/api/alerts` |
| **Fleet** | Searchable full-fleet, per-machine, or cross-machine per-project topology; switchable graph/compact-list layouts; machine → project → client/service → agent rollups; `mailbox serve` status; click-through to Console | `hq.snapshot` |
| **Console** | Full chat transcript plus exact-client control composer for leader/subagent `steer` / `btw` / `queue`, targeted interrupt, optional leader+fleet interrupt, and optimistic outbound turns whose queued → delivered → acked state updates in the chat history | `/api/sessions/:id/events`, live `session.transcript`, `hq.command_status` |
| **Mailbox** | Live feed + grouped-by-project message browser with type/priority/project/search filters | `hq.snapshot`, `mailbox.event` (backfilled from `/api/events`) |
| **Kanban** | Read-only project and board selector with columns, cards, WIP limits, task status, assignees, labels, dependencies, and due dates synchronized across clones and machines | `/api/projects/:projectId/kanban`, live `kanban.snapshot` refresh trigger |
| **Cost** | Hero total, per-project share bars, per-session/model breakdown | `hq.snapshot` |
| **Brain** | Decision / intervention timeline | `brain.event` (backfilled from `/api/events`) |
| **Worktrees** | Per-owner lifecycle lanes (allocated → committed → merged / conflict / failed) | `worktree.event` (backfilled) |
| **Trends** | KPI tiles + SVG column charts (cost / tokens / tool calls) with hover tooltips and 1h–7d range filters | `/api/trends/cost` |
| **Alerts** | Live alert feed + history | `hq.alert`, `/api/alerts` |
| **Control** | Advanced staged command composer (`steer` / `btw` / `queue` / `abort` / `spawn` / `broadcast` / gated `run-command`) with fully-qualified machine/project/process/session targets, preview + typed-confirmation gates, and live audit trail | `POST /api/command`, `/api/commands`, `hq.command_status` |
| **Security** | Browser password and credential management | `/api/auth/status`, `/api/auth/password` |

Panel source: `packages/webui-hq/` (views under `src/views/`, the
transcript accumulation layer in `src/lib/transcript-store.ts`). An
opt-in Playwright smoke drives the whole panel end-to-end:
`WSTACK_E2E=1 pnpm vitest run packages/cli/tests/hq-visual-smoke.test.ts`.

## Client-side environment variables

Clients (CLI/REPL / TUI / WebUI / SimpleUI / Desktop / brain mailbox / agent-loop
checker mailbox) read HQ config from the environment and publish telemetry
when configured. The resolution logic lives in
`packages/core/src/hq/factory.ts` (`resolveHqConfigFromEnv()`,
`createHqPublisherFromEnv()`).

| Variable | Type | Default | Description |
|---|---|---|---|
| `WRONGSTACK_HQ_URL` | string | _(unset)_ | HQ endpoint. Accepts `http://host:port`, `https://host:port`, `ws://host:port[/path]`, or `wss://host:port[/path]`. The publisher normalizes the scheme (`http`→`ws`, `https`→`wss`) and appends `/ws/client` if the path is `/` or empty. When unset, the client falls back to same-machine **auto-discovery** (see below) |
| `WRONGSTACK_HQ_ENABLED` | `0` / `1` | `1` (auto-discovery) | `0` disables publishing entirely — including auto-discovery. Any other non-empty value forces enabled even when config says otherwise |
| `WRONGSTACK_HQ_TOKEN` | string | _(unset)_ | Optional client enrollment token. When set, the publisher appends it as a `?token=…` query parameter on the `/ws/client` upgrade. Required by Phase 2+ when the server runs in remote/auth mode |
| `WRONGSTACK_HQ_PASSWORD` | string | _(unset)_ | Server-side browser password used when `--password` is omitted. Sets or rotates the scrypt hash at startup; minimum 8 characters |
| `WRONGSTACK_HQ_RAW_CONTENT` | `0` / `1` | `1` | Publish raw prompt / output / file / log content. Defaults to **on** for every HQ target unless explicitly disabled. Set `0` to force raw-content redaction. Maps to `HqRedactionPolicy.rawContent` |
| `WRONGSTACK_HQ_PROJECT_ALIAS` | string | _(unset)_ | Optional HQ display name and legacy identity fallback. A committed `.wrongstack/project.json` takes precedence for identity |

### Auto-discovery mode (default)

When neither `WRONGSTACK_HQ_URL` nor a config `hq.url` is set,
`resolveHqConfig()` returns a config with `discover: true` and
`createHqPublisherFromEnv()` builds a publisher in **auto-discovery** mode:

- Before every connect attempt the publisher re-resolves the endpoint from
  `<dataDir>/runtime.json` (pid-liveness-checked) and picks up the first
  client token from `<dataDir>/auth.json` — so it follows an HQ that starts
  later, restarts, or moves to another port.
- While no HQ is advertised, the publisher stays **dormant**: no socket is
  dialed; a cheap fixed-interval file poll (default 5 s) re-checks the marker.
  Published telemetry queues in the publisher's bounded buffer and flushes
  after the `client.hello` handshake once an HQ appears.
- The only opt-out is explicit: `WRONGSTACK_HQ_ENABLED=0`, config
  `hq.enabled: false`, or `/hq off`. Then no publisher is constructed and
  behavior is identical to a build without HQ support.
- `WRONGSTACK_HQ_RAW_CONTENT` / config `hq.rawContent` and
  `WRONGSTACK_HQ_PROJECT_ALIAS` / config `hq.projectAlias` apply in
  auto-discovery mode exactly as with an explicit URL. HQ defaults to **raw**
  content for every target; set `/hq raw off` or `WRONGSTACK_HQ_RAW_CONTENT=0`
  only when you explicitly want redacted telemetry. Changes take effect for
  sessions started afterwards.

### Config-file integration

The `hq` block in the active profile config (`hq.url`, `hq.token`,
`hq.enabled`, `hq.rawContent`, `hq.projectAlias`, `hq.dataDir`) is consumed
by `resolveHqConfig()`; env vars override the config file. The `/hq` slash
command writes this block (see [`/hq`](../slash/hq.md)).

### Project identity and Kanban synchronization

HQ stores Kanban records under the committed repository identity in
`.wrongstack/project.json`:

```json
{
  "version": 1,
  "projectId": "proj_01J00000000000000000000000"
}
```

Commit this file once. Clones, worktrees, and forks that retain it publish to
the same HQ project and synchronize the same Kanban records across machines.
The identity lifecycle is explicit:

```bash
wstack project id
wstack project init
wstack project rekey --yes   # only when a fork becomes an independent project
```

`hq.projectAlias` remains useful as a human-readable display name. It is also
the legacy identity fallback for repositories that do not yet contain
`.wrongstack/project.json`.

When neither a committed identity nor an alias exists, WrongStack preserves the
old absolute-path hash fallback. That fallback is machine-local and therefore
does not synchronize independent copies.

### URL normalization examples

| `WRONGSTACK_HQ_URL` value | Final WebSocket URL |
|---|---|
| `http://localhost:3499` | `ws://localhost:3499/ws/client` |
| `https://hq.example.com` | `wss://hq.example.com/ws/client` |
| `ws://hq.example.com/ws/client` | `ws://hq.example.com/ws/client` |
| `wss://hq.example.com/ws/custom` | `wss://hq.example.com/ws/custom` |
| `http://hq.example.com/` (with `WRONGSTACK_HQ_TOKEN=abc`) | `ws://hq.example.com/ws/client?token=abc` |

## Connecting clients

**Same machine:** just run the clients — no env vars needed. Auto-discovery
attaches them to the local HQ (running now or started later):

```bash
# Terminal 1 — HQ (any time, before or after the clients)
wstack --hq

# Terminal 2 — TUI client (auto-discovers)
wstack

# Terminal 3 — REPL client (auto-discovers)
wstack repl
```

**Other machines:** export `WRONGSTACK_HQ_URL` (and `WRONGSTACK_HQ_TOKEN` in
TOKEN MODE). Each client connects on start, sends a `client.hello`, and then
publishes events as they happen:

```bash
# Terminal 4 — WebUI server on another machine
WRONGSTACK_HQ_URL=http://hq-host:3499 wstack --webui --webui-port 4000
```

A client only needs to be in the same network as HQ; it does not need to
share a project root. Multiple projects can publish to the same HQ
simultaneously.

## Remote / relay deployment

> ⚠️ **Current security posture.** The HQ server implements
> **token-based authentication** for both browser (`/ws/browser`) and
> client (`/ws/client`) WebSocket channels, with **live reload** of the
> token lists from `auth.json`, same-origin checks for browser writes and
> WebSocket upgrades, security response headers, scoped token capabilities,
> strict protocol validation, password login with throttling, and server-side
> redaction. HQ itself does **not** terminate TLS and Quick Tunnel is intended
> only for temporary development/demo sharing. For unattended deployments, use
> token/password mode plus a production TLS-terminating, identity-aware proxy.
> The plan for stricter browser controls lives in
> [Access Control and Security](../plans/hq-command-center-2026-06.md#access-control-and-security).
> The consolidated threat model, defaults, and roadmap are tracked
> in [SECURITY.md](../../SECURITY.md). Treat anything below as
> forward-looking guidance, not a supported production configuration.

### LAN / local network (all-interface default)

`--hq` binds to `0.0.0.0` by default, so machines on the same LAN can connect.
To restrict connections to this machine, pass `--host 127.0.0.1`. The explicit
LAN form is:

```bash
# On the relay machine (the HQ host)
wstack --hq --host 0.0.0.0 --port 3499
```

Then on each client machine on the same LAN:

```bash
export WRONGSTACK_HQ_URL=http://<hq-host>:3499
```

**Caveats that apply today:**

- Browser and client token auth is enforced on the respective `/ws/*`
  upgrade when TOKEN MODE is active (tokens present in `auth.json`). In
  OPEN MODE (no tokens), any connection is accepted.
- Browser-originated writes and both WebSocket upgrades require a same-host
  `Origin`. Native clients without an `Origin` header remain supported.
- All HTTP routes (`/`, `/api/snapshot`, `/api/projects/:id`) are
  token-gated when browser TOKEN MODE is active — the same browser token
  that unlocks `/ws/browser` also unlocks HTTP access via `?token=` or
  `Authorization: Bearer`. In OPEN MODE (no browser tokens), HTTP routes
  remain unauthenticated.

### TLS termination (reverse proxy / Cloudflare Tunnel)

HQ itself speaks plain HTTP/WS — it does not terminate TLS. For any
deployment that is not loopback, terminate TLS in front of it and let the
proxy upgrade `https://` → `ws://` / `wss://` → `ws://`. The publisher's
`toClientUrl()` (see `packages/core/src/hq/publisher.ts`) rewrites the
scheme automatically:

| Client sets `WRONGSTACK_HQ_URL=` | HQ receives |
|---|---|
| `https://hq.example.com` | proxied HTTPS → HTTP on the HQ loopback port |
| `wss://hq.example.com/ws/client` | proxied TLS WebSocket → plain WS on the HQ loopback port |

For a temporary development/demo tunnel, HQ can manage `cloudflared` itself:

```bash
wstack --hq --tunnel --password "use-a-strong-password" --open
```

The origin binds to `127.0.0.1`; HQ prints a random HTTPS
`*.trycloudflare.com` URL and shuts the tunnel down with the HQ process.
Quick Tunnels are temporary, change URL on restart, and are not a production
deployment mechanism. HQ refuses to publish an explicit open-mode auth file.

The equivalent manual flow remains available:

```bash
wstack --hq --host 127.0.0.1 --port 3499   # loopback only
cloudflared tunnel --url http://localhost:3499
```

Keep HQ on `127.0.0.1` and let `cloudflared` be the only thing that can
reach it. Keep the browser password/token and the separate client enrollment
token enabled even when another access layer sits in front of HQ.

### VPS / public internet

Do **not** run `wstack --hq --host 0.0.0.0` on a public VPS without
TOKEN MODE + a TLS-terminating proxy. In OPEN MODE there is nothing
preventing an unauthenticated client or browser from connecting. The plan's
[VPS guidance](../plans/hq-command-center-2026-06.md#vps-guidance) lists
the prerequisites (HTTPS reverse proxy, strong password, client enrollment
tokens, explicit retention/data directory, no raw content publishing) —
all of which require Phase 2 auth work that has not shipped yet.

### Authentication and persistence status

The dashboard's **System → Security** view shows the active browser auth
methods and supports enabling, changing, or removing the password plus logging
out the current browser. CLI `--password` / `WRONGSTACK_HQ_PASSWORD` remain
available for headless recovery.

Phase 2 is landing in slices. What is already shipped:

- **`--data-dir` flag** — HQ data directory override. Resolves to
  `~/.wrongstack/hq` by default (honoring `WRONGSTACK_HOME`), or to the
  `WRONGSTACK_HQ_DATA_DIR` env var, or to the explicit `--data-dir <path>`
  flag (flag wins). See the flags table above.
- **`~/.wrongstack/hq/auth.json`** — operator-configured auth file.
  Written atomically (tmp + rename) with mode `0o600`. Current schema:
  ```json
  {
    "version": 1,
    "updatedAt": "2026-06-21T12:00:00.000Z",
    "redactionPolicy": { "rawContent": false, "toolArgs": "summary", "paths": "project-relative" },
    "browserTokens": [],
    "clientTokens": []
  }
  ```
  - `redactionPolicy` (optional): operator override applied server-side.
    When present, the HQ server merges it over `DEFAULT_HQ_REDACTION_POLICY`
    and the result is sent to clients in the `hq.welcome` handshake. The
    operator can therefore tighten whatever publishers declare — never
    loosen.
  - `browserTokens` (optional): issued browser tokens. Phase 3 populates
    this via `wstack hq token create` and validates tokens on `/ws/browser`.
    See **TOKEN MODE** below.
  - `clientTokens` (optional): issued client tokens. Phase 4 populates this
    via `wstack hq token create --client` and validates tokens on `/ws/client`.
    See **TOKEN MODE** below.
  - Missing or corrupt file: server starts with an empty policy and emits
    an `hq.auth_load_failed` warning. The operator can recover by editing
    or deleting the file.
  - Helpers in `@wrongstack/core`: `resolveHqDataDir()`, `readHqAuthFile()`,
    `writeHqAuthFile()`, `mutateHqAuthFile()`, `mintHqToken()`,
    `watchHqAuthFile()` (Phase 4 live reload).

Also shipped since:

- **Persistent event log + snapshot cache + time series** —
  `<dataDir>/events.jsonl` (rotated), `<dataDir>/snapshot.json` (atomic
  checkpoint) and `<dataDir>/timeseries.jsonl` (5-min buckets, 1-week
  retention) so a restart preserves recent history; served via
  `/api/events` and `/api/trends/cost`.
- **Frame-size cap** — the WS server runs with a 1 MiB `maxPayload`.

What is still coming (Phase 7 remainder):

- **Token hash-at-rest** — SHA-256 in `auth.json`; raw token returned once
  on mint.
- **Per-client rate limiting** on the HTTP routes (mirror `WEBUI_RATE_LIMIT`).

> **Phase 4 shipped.** Client token validation (`/ws/client`) and live
> `auth.json` reload via a file-watcher are now live. See **TOKEN MODE**
> below for details.

### TOKEN MODE

The HQ server has two independent auth channels, each with its own token
list in `<dataDir>/auth.json`:

| Channel | Endpoint | Token list | `--client` flag |
|---|---|---|---|
| Browser | `/ws/browser` | `browserTokens` | _(default, no flag)_ |
| Client | `/ws/client` | `clientTokens` | `--client` / `-c` |

Each channel operates independently in OPEN MODE or TOKEN MODE:

- **OPEN MODE** (explicit/backwards compatible): the channel's token list
  is empty or absent → all connections to that endpoint are accepted. A
  brand-new data directory does not use this mode; first run creates scoped
  browser and client tokens. To opt into open mode, keep an existing
  `auth.json` with empty token arrays and bind only to loopback.
- **TOKEN MODE**: one or more tokens exist → connections must append
  `?token=<full-token>` to the upgrade URL. Unknown or missing tokens are
  rejected at the HTTP layer with `401 Unauthorized`.

**Cross-channel isolation:** a browser token cannot be replayed on
`/ws/client` and vice versa. The two token lists are validated against
their respective endpoints only. This means a browser dashboard token
(leaked via a shared URL) does not grant telemetry-publishing access.

Workflow:

```bash
# Mint a browser token (server does NOT need to be running):
$ wstack hq token create "erwin@laptop"
Created browser token.
  id:         7a3c1f2e-...
  label:      erwin@laptop
  capabilities: control.enqueue
  token:      e1b8c0a3...
  createdAt:  2026-06-21T12:00:00.000Z

Connect with: ws://localhost:3499/ws/browser?token=e1b8c0a3...
(Copy the token now — it will not be shown again in full.)

# Mint a client token (for CI / remote client enrollment):
$ wstack hq token create --client "ci-runner"
Created client token.
  id:         9b4d2e3f-...
  label:      ci-runner
  capabilities: telemetry.publish
  token:      f2c9d1b4...
  createdAt:  2026-06-21T12:01:00.000Z

Connect with: ws://localhost:3499/ws/client?token=f2c9d1b4...
(Copy the token now — it will not be shown again in full.)

# Explicitly opt a trusted client into the run-command gate. The client
# must also be launched with --hq-allow-exec; commands still enter through
# the agent permission policy.
$ wstack hq token create --client \
    --capabilities telemetry.publish,control.execute "trusted-operator"

# Start the server:
$ wstack hq --port 4000

# Open the dashboard with the browser token:
$ open "http://127.0.0.1:4000/?token=e1b8c0a3..."
# The dashboard's connect() reads `?token=` from the URL query string and
# appends it to its /ws/browser upgrade.

# Connect a client with the client token:
$ export WRONGSTACK_HQ_URL=http://localhost:4000
$ export WRONGSTACK_HQ_TOKEN=f2c9d1b4...
$ wstack
# The publisher appends the token as ?token= on the /ws/client upgrade.
```

Listing and revoking:

```bash
$ wstack hq token list
Browser tokens (1) — TOKEN MODE:
  7a3c1f2e-...  e1b8c0…0a3  2026-06-21T12:00:00.000Z  "erwin@laptop"  [control.enqueue]

$ wstack hq token list --client
Client tokens (1) — TOKEN MODE:
  9b4d2e3f-...  f2c9…d1b4  2026-06-21T12:01:00.000Z  "ci-runner"  [telemetry.publish]

$ wstack hq token revoke 7a3c1f2e
Revoked browser token 7a3c1f2e-... ("erwin@laptop").

$ wstack hq token revoke --client 9b4d2e3f
Revoked client token 9b4d2e3f-... ("ci-runner").
```

### Live reload (Phase 4)

The HQ server watches `<dataDir>/auth.json` for changes and refreshes its
in-memory token sets and operator redaction policy **without a restart**.
This means:

- Running `wstack hq token create` / `revoke` in another terminal takes
  effect immediately — the next WebSocket upgrade sees the new token list.
- Editing `auth.json` directly (e.g., by a config-management tool) is also
  picked up.
- No active connections are dropped; only subsequent upgrade attempts are
  affected by token changes.

The watcher debounces events (200ms default) because most editors do a
tmp+rename dance that emits multiple `fs.watch` events. On read failure
(file deleted, corrupt, etc.) the server logs a warning and keeps the
previous valid state; a future valid write re-triggers the reload.

> **Platform note:** `fs.watch` is best-effort across platforms. On some
> network filesystems events may not fire; the operator must restart the
> server to pick up changes in that case.

The supported posture is: loopback for a developer machine, optional LAN
exposure on a trusted network, or `--tunnel` for short-lived demos with
password/token protection. Production exposure needs a durable, trusted TLS
proxy that does not forward unauthenticated traffic. The authoritative
source for the HQ security posture is [SECURITY.md](../../SECURITY.md)
(sections *HQ command center (Phase 1)* and *HQ Phase 2 auth roadmap*) —
this subcommand doc reproduces the highlights but defers to SECURITY.md
for the full set of controls and accepted risks.

## Exit codes

The HQ path in `cli-main.ts` does not install its own `process.on('uncaughtException')`
or `process.on('unhandledRejection')` handlers. Exit semantics therefore
depend on which early-exit path fires:

| Code | Trigger | Source |
|---|---|---|
| `0` | `SIGINT` (Ctrl+C) or `SIGTERM` after the HQ server is listening. `cli-main.ts` line 185-191 registers both, calls `handle.close()` then resolves the blocking Promise → `main()` returns `0` | `cli-main.ts:185-191` |
| `0` | Server stops cleanly (rare; the normal flow is SIGINT/SIGTERM, not graceful shutdown) | `cli-main.ts:192` |
| `0` | `wstack --hq --help` or `wstack --hq --version` — the help/version short-circuit returns the handler's exit code before reaching the HQ dispatch | `cli-main.ts:161-166` |
| non-zero | `startHqServer()` rejects: `--strict-port` set and port is in use, port already bound by another process after auto-advance attempts, host unreachable, or `port` is `NaN` from `--port <non-numeric>`. The rejection propagates as an uncaught promise rejection (Node default behavior) and Node exits with a non-zero code | `hq-server.ts:739-745` |
| non-zero | Runtime exception during `handle.close()` or during `openBrowser()` (best-effort path is swallowed, but errors in `handle.close()` propagate as a rejected promise in the SIGINT/SIGTERM handler) | `cli-main.ts:185-191` |

In practice the only common non-zero case is port collision under
`--strict-port`. Without `--strict-port`, the server silently auto-advances
(`port + 1`) on the first `EADDRINUSE` and only rejects if the next port
is also taken.

## Code reference

- `packages/cli/src/hq-server.ts` — `startHqServer`, route handlers,
  control plane, transcript rings, persistence wiring
- `packages/cli/src/hq-static-serve.ts` — resolve + serve the built
  `@wrongstack/webui-hq/dist` (inline `HQ_HTML` fallback when unbuilt)
- `packages/webui-hq/` — the React dashboard (12 views + transcript store)
- `packages/cli/src/arg-parser.ts` — `--hq`, `--host`, `--port`,
  `--strict-port`, `--open` boolean flags
- `packages/cli/src/cli-main.ts` — early `--hq` dispatch (before `boot()`)
- `packages/cli/tests/hq-server.test.ts` — HTTP serve, snapshot API,
  client hello + event broadcast, project drilldown endpoint,
  mailbox aggregation, protocol mismatch, drawer markup, live event feed
- `packages/core/src/hq/` — protocol, redaction, mapper, publisher,
  factory (client-side)
- `packages/core/src/coordination/global-mailbox.ts` — `GlobalMailbox` →
  `HqPublisher` wiring
- `packages/core/src/mailbox-attach.ts` — agent-loop checker mailbox
  publisher injection
- `docs/plans/hq-command-center-2026-06.md` — architecture and phased plan
- `docs/configuration.md` — full HQ env-var reference table

## Shared mailbox router

The canonical external-agent mailbox HTTP protocol lives in
`packages/core/src/coordination/mailbox-http-router.ts`. Both
`wstack mailbox serve` and `wstack --hq` mount it; one implementation,
two hosts.

What the router owns:

- The full `/mailbox/*` route table — `/mailbox/send`, `/mailbox/query`,
  `/mailbox/check` (with batch `ackMany`), `/mailbox/ack`,
  `/mailbox/ack-many`, `/mailbox/unread-count`,
  `/mailbox/agents/register`, `/mailbox/agents/heartbeat`,
  `/mailbox/register-client`, `/mailbox/heartbeat`,
  `/mailbox/agents`, `/mailbox/agents/online`, and the
  `/mailbox/events` SSE stream.
- Request validation (256 KiB body cap, required field coercion,
  reserved internal-identity protection for `from` and `readerId`).
- Constant-time bearer-token comparison (`timingSafeEqual`) and a
  sliding-window rate limiter (`MailboxHttpRateLimiter`) keyed by an
  opaque host-supplied identifier. Rate-limited requests return
  `429 { error: { code: "RATE_LIMITED" } }`.
- `/healthz` is **always** served unauthenticated (liveness probes,
  container orchestrators, `curl http://host/healthz`).
- A `router.close()` hook the host calls before `server.close()` so
  active SSE responses do not pin the event loop during shutdown.

What the router does NOT own:

- Authentication. Hosts pass an `authorize` callback that decides
  allow/deny and a `rateLimitKey`. The standalone bridge uses a
  constant-time bearer-token check; HQ uses the existing browser
  cookie / token check plus the `control.enqueue` capability gate.
- Project / lock / token-file lifecycle. The standalone bridge owns
  the per-project lock and token file (`acquireOrJoin` / `finalize` /
  `release`). HQ resolves `projectId` via `SessionRegistry` and caches
  one `(GlobalMailbox, router)` pair per project so SSE subscribers
  see writes from legacy HQ routes on the same emitter.
- Multi-project scope. The router is single-project per
  instantiation. HQ instantiates lazily — one router per project.

Use the shared router rather than writing your own
`http.createServer`:

1. The wire contract is single-sourced, so the standalone bridge and
   HQ stay byte-identical to external clients.
2. Guards (`scripts/guard-mailbox-bridge.mjs`) verify the route
   literals and `'http'` source-union in core; new routes should land
   there.
3. `MailboxHttpRateLimiter`, `authorizeMailboxBearerToken`, and the
   router are exported from `@wrongstack/core/coordination` — they
   stay consistent across hosts.

## Project-scoped mailbox gateway (`/api/projects/:projectId/mailbox/<route>`)

HQ mounts the shared router at a project-scoped path so dashboards,
external scripts, and the browser can talk to per-project mailboxes
without running the standalone bridge. Each project gets one lazily
created `(GlobalMailbox, router)` pair, and writes from legacy HQ
routes (`POST /api/mailbox-send`, mailbox message actions) flow
through the same cached mailbox so SSE subscribers on the new path
see them in real time.

### Path → mailbox protocol

Request paths under `/api/projects/:projectId/mailbox/` are rewritten
to the canonical `/mailbox/<route>` and dispatched via the same router
the standalone bridge uses. The full route table is therefore
identical to the standalone `wstack mailbox serve` (see the
[Shared mailbox router](#shared-mailbox-router) section above).

### Resolution and security

- **`projectId`** is resolved server-side via the `SessionRegistry`
  (matched by `projectSlug` and the `sha256(projectRoot)[:12]` stamp
  HQ publishers attach). Raw filesystem paths are **not** accepted.
  Unknown `projectId` returns `404`.
- **Auth** mirrors `/api/command` and `/api/mailbox-send`: requires a
  browser token (cookie or `?token=`/`Authorization: Bearer`); the
  `control.enqueue` capability is enforced **before** project lookup so
  a scoped token cannot exploit the 403/404 distinction to enumerate
  project ids.
- **CORS / cross-origin** is unchanged from the rest of HQ's HTTP
  routes: same-origin only.
- **Body / rate-limit** comes from the shared router: 256 KiB cap and
  the host-supplied rate-limit key (here, `hq:<identity>:<projectDir>`).

### Example

```bash
curl -s -X POST http://127.0.0.1:3499/api/projects/wrongstack-core/mailbox/send \
  -H "Authorization: Bearer $HQ_BROWSER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "from":"external-bot",
    "to":"leader",
    "type":"note",
    "subject":"hello from curl",
    "body":"via the HQ gateway"
  }'
```

```bash
curl -N http://127.0.0.1:3499/api/projects/wrongstack-core/mailbox/events \
  -H "Authorization: Bearer $HQ_BROWSER_TOKEN"
```

The SSE connection also receives `message.sent` for events written via
the legacy `POST /api/mailbox-send`, since both routes share the same
cached `MailboxEventEmitter`.

### Shutdown contract

HQ calls `router.close()` on every cached gateway before closing the
HTTP server and clears the cache in the same shutdown step, so no SSE
subscriber leaks across server restarts.
