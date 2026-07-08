# `wstack --hq` — HQ Command Center

`wstack --hq` starts a local read-only **HQ command center**: a single
HTTP+WebSocket process that listens on one port and serves an inline HTML
dashboard at `/`. The dashboard aggregates telemetry from every
WrongStack client (TUI, REPL, CLI-embedded WebUI, standalone WebUI) that
connects to the same URL.

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

This is Phase 1 — read-only observation. Control commands (browser → client)
are intentionally out of scope.

## Usage

| Command | Effect |
|---|---|
| `wstack --hq` | Start HQ on the default host/port (`127.0.0.1:3499`) |
| `wstack --hq --host 0.0.0.0` | Listen on all interfaces (LAN/VPS access) |
| `wstack --hq --port 4000` | Override the default port |
| `wstack --hq --strict-port` | Fail (exit non-zero) if the requested port is busy instead of auto-advancing |
| `wstack --hq --open` | Auto-open the dashboard in the user's default browser after the server starts |
| `wstack hq` | Equivalent to `wstack --hq` (subcommand form) |
| `wstack hq serve` | Same as `wstack hq` (explicit form) |
| `wstack hq token create [label]` | Mint a browser token (enters TOKEN MODE), write to `<dataDir>/auth.json` |
| `wstack hq token create --client [label]` | Mint a client token for `/ws/client` enrollment (Phase 4) |
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
| `--host` | `--host <ip>` or `--host=<ip>` | string | `127.0.0.1` | Bind host. Use `0.0.0.0` for LAN/VPS access |
| `--port` | `--port <n>` or `--port=<n>` | number | `3499` | Bind port. Parsed via `Number.parseInt(value, 10)`; non-numeric values fall through as `NaN` and `startHqServer` will reject the bind |
| `--strict-port` | `--strict-port` | boolean | `false` | Fail if the requested port is in use; otherwise scan forward for a free port (bounded). Only takes effect when passed as a standalone flag (no value) — a `--strict-port <value>` form is ignored because `strict-port` is not in the `BOOLEAN_FLAGS` set and the dispatch checks `=== true` |
| `--open` | `--open` | boolean | `false` | Open the dashboard URL in the default browser after the server prints its listening URL. Implementation: dynamic `import('@wrongstack/webui/server')` of `openBrowser()`. Errors are best-effort and silently swallowed |
| `--data-dir` | `--data-dir <path>` or `--data-dir=<path>` | string | `~/.wrongstack/hq` | HQ data directory: where `auth.json` (and in later phases, the persistent event log + snapshot cache) live. Relative paths resolve against `process.cwd()`. The env var `WRONGSTACK_HQ_DATA_DIR` provides the same override without a CLI flag; the flag wins when both are set. The default honors `WRONGSTACK_HOME`, so pointing that at a sandbox also relocates HQ state |
| `--client` | `--client` or `-c` | boolean | `false` | Token subcommand scope selector. When passed to `wstack hq token create/list/revoke`, operates on **client tokens** (validated on `/ws/client`) instead of the default **browser tokens** (validated on `/ws/browser`). Phase 4 |

`--host` and `--port` accept both forms:
- `--key=value` → `flags[name] = "value"` (parsed by the `=` branch)
- `--key value` (next arg does not start with `-`) → `flags[name] = "value"` (parsed by the positional-value branch)
- `--key` alone → `flags[name] = true` (parser falls through to boolean)

`--hq` and `--open` are listed in `BOOLEAN_FLAGS` in `arg-parser.ts:7-42`,
so they are always boolean. `--host`, `--port`, `--strict-port` are NOT in
that set, so they accept a value when one is present.

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
- Other flags that the HQ path ignores (e.g. `--tui`, `--webui`,
  `--director`, `--recover`) are silently dropped on the HQ path because
  the dispatch never reaches `boot()`.

## HTTP routes

| Route | Method | Response | Notes |
|---|---|---|---|
| `/` | GET | `text/html` | The HQ browser UI. Self-contained — no JS bundle, no asset host |
| `/api/snapshot` | GET | `application/json` (`HqSnapshot`) | Same shape the browser receives on `/ws/browser` connect (see `HqSnapshot` schema in `protocol.ts`) |
| `/api/projects/:id` | GET | `application/json` (`ProjectDetail`) | Drilldown endpoint used by the project drawer |
| `/ws/browser` | WS upgrade | Stream of `HqBrowserMessage` frames | Browser connects here. Receives the current snapshot immediately, then live updates |
| `/ws/client` | WS upgrade | Stream of `HqClientMessage` / `HqServerMessage` frames (bidirectional) | Telemetry clients (TUI/REPL/WebUI) connect here. Protocol version mismatch → close `1008` |
| `/api/command` | POST | `application/json` (`202` on accept) | **Control plane.** Enqueue a command to a **connected** client. Requires a browser token with `control.enqueue` (open mode allows any). Target client must advertise `control.receive`. See [Control plane](#control-plane) |
| `/api/commands` | GET | `application/json` | Recent command audit entries (`?limit=`, default 200) |
| `/api/mailbox-send` | POST | `application/json` (`202` on delivery) | **Direct mailbox write** — deliver a prompt even when **no client is connected**. Same auth as `/api/command`. See [Direct mailbox delivery](#direct-mailbox-delivery-apimailbox-send) |

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
  "type": "steer",               // steer | btw | queue | broadcast
  "to": "leader",                // agent address (default "leader"); ignored for broadcast
  "subject": "HQ prompt",
  "body": "continue please",
  "priority": "high"
}
```

Auth mirrors `/api/command` (browser token + `control.enqueue`).
Responses:

| Status | Meaning |
|---|---|
| `202` | Delivered. Body: `{ delivered: true, messageId, to, type }` (`type` is the emitted mailbox type — e.g. `queue` → `note`). |
| `400` | Missing `type`/`body`, missing both `sessionId` and `projectId`, or an unrecognized/non-mailbox type. |
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
| Server → browser | `HqBrowserMessage` | `HqBrowserSnapshotMessage` (`type: "hq.snapshot"`), `HqBrowserEventMessage` (`type: "hq.event"`), `HqAlertMessage` (`type: "hq.alert"`) |
| Client → server | `HqClientMessage` | `HqClientHelloMessage` (`type: "client.hello"`), `HqClientEventMessage` (`type: "client.event"`), `HqClientCommandPollMessage` (`type: "client.command_poll"`), `HqClientCommandAckMessage` (`type: "client.command_ack"`) |
| Server → client | `HqServerMessage` | `HqWelcomePayload` (`type: "hq.welcome"`, sent on every `client.hello`), `HqServerCommandBatchMessage` (`type: "hq.command_batch"`, Phase 2 — not emitted yet) |

### Browser → server

The browser is read-only in Phase 1; it never sends frames.

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

`hq.alert` — server-pushed alert (not yet emitted in Phase 1, reserved for
later phases):

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

The current server (`packages/cli/src/hq-server.ts:794-801`) reads raw
frames with `JSON.parse(...) as HqClientMessage`. The cast is unsafe —
a malformed frame slips through as long as JSON parses. A stricter
helper narrows to the union explicitly with type guards and surfaces
unrecognized frames so the server can log / drop them:

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

The dashboard is a single self-contained HTML page. Top-level layout:

- **Toolbar** — connection status, project picker dropdown, last-refreshed
  timestamp.
- **Global stat cards** — active clients, projects, mailboxes, unread,
  open, high-priority, online agents (warn-colored cards for unread and
  open, high-colored for high-priority).
- **Mailboxes table** — per-mailbox counts (messages / unread / open /
  high / agents). Project column is a clickable link that opens the
  drilldown drawer.
- **Clients table** — client id, kind, project id, capability chips,
  last-seen time.

### Project drilldown drawer

The drawer is a right-side slide-in panel opened by:

- Clicking a project link in the **Mailboxes** table.
- Selecting a project in the toolbar **project picker**.
- Deep-linking via `?project=<id>` query string or `#<id>` URL hash.

Contents:

1. **Meta header** — project id, scope pill (`project`/`global`), status,
   last activity, last-refreshed timestamp.
2. **Mailboxes** — short table for this project's mailboxes.
3. **Recent messages** — last 20 messages, newest first, with scrubbed
   preview, priority pill, and state badge.
4. **Clients** — clients connected to this project, with capability chips.
5. **📡 Live mailbox events** — per-project ring buffer (50 entries) of
   every `mailbox.event` envelope received for that project. The buffer
   accumulates even when the drawer is closed, so re-opening the drawer
   immediately shows events that arrived in the interim (newest first).
   Each row shows an action pill (color-coded: `message.sent` blue,
   `message.completed`/`agent.registered` green, `message.read` gray,
   `agent.offline` red, …), a short summary (subject / from / to or
   agent identity), and a timestamp.

The drawer auto-refreshes (debounced ~250 ms) whenever a global `hq.snapshot`
containing the open project arrives. The event feed is preserved across
refreshes because it lives in a client-side `Map<projectId, event[]>`.

A "live" status indicator next to the section title pulses green for 1.5 s
after each new event, then reverts to "idle". Switching projects preserves
each project's feed history, and re-opening a previously-closed project
drawer renders the accumulated buffer immediately.

Press `Escape` or click the backdrop to close the drawer. Closing also
clears the URL hash.

## Client-side environment variables

Clients (TUI / REPL / WebUI / standalone WebUI / brain mailbox / agent-loop
checker mailbox) read HQ config from the environment and publish telemetry
when configured. The resolution logic lives in
`packages/core/src/hq/factory.ts` (`resolveHqConfigFromEnv()`,
`createHqPublisherFromEnv()`).

| Variable | Type | Default | Description |
|---|---|---|---|
| `WRONGSTACK_HQ_URL` | string | _(unset)_ | HQ endpoint. Accepts `http://host:port`, `https://host:port`, `ws://host:port[/path]`, or `wss://host:port[/path]`. The publisher normalizes the scheme (`http`→`ws`, `https`→`wss`) and appends `/ws/client` if the path is `/` or empty. When unset, the client falls back to same-machine **auto-discovery** (see below) |
| `WRONGSTACK_HQ_ENABLED` | `0` / `1` | `1` (auto-discovery) | `0` disables publishing entirely — including auto-discovery. Any other non-empty value forces enabled even when config says otherwise |
| `WRONGSTACK_HQ_TOKEN` | string | _(unset)_ | Optional client enrollment token. When set, the publisher appends it as a `?token=…` query parameter on the `/ws/client` upgrade. Required by Phase 2+ when the server runs in remote/auth mode |
| `WRONGSTACK_HQ_RAW_CONTENT` | `0` / `1` | `0` | When `1`, opt-in to publishing raw prompt / output / file / log content. When `0` (default), only normalized summaries and scrubbed previews are sent. This maps to `HqRedactionPolicy.rawContent` |
| `WRONGSTACK_HQ_PROJECT_ALIAS` | string | basename of project root | Human-readable project name shown in HQ. Overrides the default `basename(projectRoot)` fallback (`"unknown"` if both are missing) |

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

### Config-file integration

The `hq` block in `~/.wrongstack/config.json` (`hq.url`, `hq.token`,
`hq.enabled`, `hq.rawContent`, `hq.projectAlias`, `hq.dataDir`) is consumed
by `resolveHqConfig()`; env vars override the config file. The `/hq` slash
command writes this block (see [`/hq`](../slash/hq.md)).

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
WRONGSTACK_HQ_URL=http://hq-host:3499 wstackui --port 4000
```

A client only needs to be in the same network as HQ; it does not need to
share a project root. Multiple projects can publish to the same HQ
simultaneously.

## Remote / relay deployment

> ⚠️ **Current security posture (Phase 4).** The HQ server implements
> **token-based authentication** for both browser (`/ws/browser`) and
> client (`/ws/client`) WebSocket channels, with **live reload** of the
> token lists from `auth.json`. However, it still does **not** implement
> browser password auth, CORS enforcement, origin checks, or rate limiting
> on its HTTP routes. For unattended / multi-tenant deployments, use
> TOKEN MODE + a TLS-terminating reverse proxy. The plan for password auth
> and stricter browser controls lives in
> [Access Control and Security](../plans/hq-command-center-2026-06.md#access-control-and-security).
> The consolidated threat model, defaults, and roadmap are tracked
> in [SECURITY.md](../../SECURITY.md). Treat anything below as
> forward-looking guidance, not a supported production configuration.

### LAN / local network (loopback default)

`--hq` binds to `127.0.0.1` by default. To allow connections from other
machines on the same LAN, bind explicitly to all interfaces:

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
- There is no origin / CORS enforcement on the `/ws/browser` upgrade. Any
  web page that can reach the HQ port can open a browser socket — use
  TOKEN MODE on untrusted networks.
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

Cloudflare Tunnel (from the plan, Phase 2+):

```bash
wstack --hq --host 127.0.0.1 --port 3499   # loopback only
cloudflared tunnel --url http://localhost:3499
```

Keep HQ on `127.0.0.1` and let `cloudflared` be the only thing that can
reach it. Even with Cloudflare Access in front, the plan recommends keeping
a separate client enrollment token on `/ws/client` once Phase 2 lands.

### VPS / public internet

Do **not** run `wstack --hq --host 0.0.0.0` on a public VPS in Phase 1.
There is nothing preventing an unauthenticated client or browser from
connecting. The plan's
[VPS guidance](../plans/hq-command-center-2026-06.md#vps-guidance) lists
the prerequisites (HTTPS reverse proxy, strong password, client enrollment
tokens, explicit retention/data directory, no raw content publishing) —
all of which require Phase 2 auth work that has not shipped yet.

### What Phase 2 adds (in progress)

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

What is still coming in later Phase 2 / Phase 3 slices:

- **Browser password auth** — password login for non-loopback browsers,
  HTTP-only session cookie, `scrypt`/`argon2` password hash. Token mode
  (shipped) covers the immediate case of "let a teammate open the dashboard
  without exposing it publicly"; password auth covers multi-tenant /
  unattended deployments.
- **Subcommands** — `wstack hq auth set-password` (paired with the
  password-auth work above).
- **Persistent event log + snapshot cache** — `<dataDir>/events.jsonl`
  and `<dataDir>/snapshot.json` so a server restart preserves recent
  history. Schema reservation is already in place.
- **Frame hygiene** — rate limiting, frame-size cap, explicit protocol
  version negotiation (the `1008` close on mismatch is already in place).

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

- **OPEN MODE** (default, backwards compatible): the channel's token list
  is empty or absent → all connections to that endpoint are accepted. Use
  this for the loopback-only developer workflow (`wstack --hq` then open
  `http://127.0.0.1:3499/`).
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
  token:      e1b8c0a3...
  createdAt:  2026-06-21T12:00:00.000Z

Connect with: ws://localhost:3499/ws/browser?token=e1b8c0a3...
(Copy the token now — it will not be shown again in full.)

# Mint a client token (for CI / remote client enrollment):
$ wstack hq token create --client "ci-runner"
Created client token.
  id:         9b4d2e3f-...
  label:      ci-runner
  token:      f2c9d1b4...
  createdAt:  2026-06-21T12:01:00.000Z

Connect with: ws://localhost:3499/ws/client?token=f2c9d1b4...
(Copy the token now — it will not be shown again in full.)

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
  7a3c1f2e-...  e1b8c0…0a3  2026-06-21T12:00:00.000Z  "erwin@laptop"

$ wstack hq token list --client
Client tokens (1) — TOKEN MODE:
  9b4d2e3f-...  f2c9…d1b4  2026-06-21T12:01:00.000Z  "ci-runner"

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

Until browser password auth lands, the supported deployment is: loopback on
the developer's own machine, optional LAN exposure on a trusted network,
with any TLS / tunnel handled by an external proxy that does not forward
unauthenticated traffic from the public internet. The authoritative
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
  inline `HQ_HTML` dashboard, drawer / live-feed / auto-refresh logic
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
