# Running WrongStack as an MCP server

WrongStack is both an MCP **client** (it connects to external MCP servers — see
`mcpServers` in [configuration.md](./configuration.md)) and an MCP **server**:
it can expose its own built-in tools to any MCP client — Claude Desktop, an IDE,
or another agent — over the standard stdio JSON-RPC transport.

```bash
wstack mcp serve            # stdio, safe: read-only tools only
wstack mcp serve --yolo     # exposes every tool, including bash/write/edit
wstack mcp serve --tools read,grep,glob   # expose only a whitelist
wstack mcp serve --resources README.md,docs/api.md
wstack mcp serve --prompts prompts/review.md,prompts/summary.md

# network-reachable (HTTP/JSON-RPC):
wstack mcp serve --http --port 7777                 # loopback only (127.0.0.1)
wstack mcp serve --http --host 0.0.0.0 --token SECRET  # LAN, token required
```

Over stdio, stdout is the JSON-RPC channel; all status/log output goes to stderr.

### Project Kanban server

Use the narrower Kanban MCP server when an external coding agent should inspect or manage durable
project work without receiving WrongStack's file, shell, or general tool surface:

```bash
wstack-kanban-mcp --project-root /absolute/project/path               # read + watch
wstack-kanban-mcp --project-root /absolute/project/path --writable    # normal mutations
wstack-kanban-mcp --project-root /absolute/project/path --destructive # delete/merge/transfer
```

It connects through the project-scoped Kanban IPC owner; it never opens `_kanban.sqlite` directly.
The bundled external-agent workflow is
`packages/core/skills/wrongstack-kanban/SKILL.md`. See
[`kanban-architecture.md`](./kanban-architecture.md#external-mcp-boundary) for its permission and
event-reconciliation contract.

The built-in preset (`wstack mcp add kanban`) spawns
`wstack-kanban-mcp --project-root . --writable` from the current working directory — the manage
tier without destructive ops. Add `--destructive` to the server's args only when agents genuinely
need delete/merge/transfer.

### Project Mailbox server

Use the dedicated Mailbox MCP server when an external coding agent needs to coordinate with
WrongStack agents without receiving the general file, shell, or tool surface:

```bash
wstack-mailbox-mcp --project-root /absolute/project/path --actor external-agent            # read + watch
wstack-mailbox-mcp --project-root /absolute/project/path --actor external-agent --writable # send + receipts + presence
wstack-mailbox-mcp --project-root /absolute/project/path --actor external-agent --admin    # full maintenance + credentials
```

The MCP process is another `RemoteMailbox` client of the existing project-scoped IPC owner; it
never opens `_mailbox.sqlite` or legacy Mailbox files. `--actor` is the authoritative identity for
sends, receipts, deletion attribution, registration, and heartbeats, so callers cannot impersonate
another actor with tool arguments. Runtime-only `control` messages remain private to WrongStack;
external clients use `steer` for normal redirection.

The bundled external-agent workflow is
`packages/core/skills/wrongstack-mailbox-mcp/SKILL.md`. See
[`mailbox-architecture.md`](./mailbox-architecture.md#external-mcp-boundary) for capability tiers
and event reconciliation.

The built-in preset (`wstack mcp add mailbox`) spawns
`wstack-mailbox-mcp --project-root . --actor external-agent --writable` from the current working
directory — send, receipts, and self-presence without `--admin` credential operations. `--actor`
is required by the server; change the default `external-agent` identity in the server's args to a
per-agent id so sends, receipts, and registration are attributed correctly.

### Project Codebase Index server

Use the dedicated Codebase Index MCP server when an external coding agent needs fast symbol search
and dependency graphs without receiving WrongStack's filesystem, shell, or general tool surface:

```bash
wstack-codebase-index-mcp --project-root /absolute/project/path            # read-only queries
wstack-codebase-index-mcp --project-root /absolute/project/path --writable # also build/refresh
```

The default surface exposes `codebase_search`, `codebase_stats`, and package/file/symbol graph
queries. `--writable` additionally exposes `codebase_index` for incremental or forced rebuilds.
The MCP process is only an adapter over the existing project-scoped named-pipe/Unix-socket IPC
service; it never opens the SQLite index directly, so CLI, TUI, WebUI, and external MCP clients keep
one deterministic project owner. Both stdio and authenticated HTTP use the shared MCP transports.
See [`packages/codebase-index-mcp/README.md`](../packages/codebase-index-mcp/README.md) for client
configuration and the complete tool inventory.

The built-in preset (`wstack mcp add codebase-index`) spawns
`wstack-codebase-index-mcp --project-root . --writable` from the current working directory so
both queries and rebuilds are available; drop `--writable` for a strictly read-only surface.

### Project Requirements Intake server

Use the dedicated Requirements Intake MCP server when an external coding agent should record
unstructured software development requests as structured intake records — without receiving
WrongStack's file, shell, or general tool surface:

```bash
wstack-requirement-intake-mcp --project-root /absolute/project/path            # list only (read tier)
wstack-requirement-intake-mcp --project-root /absolute/project/path --writable # also file + submit
```

The read tier always exposes `requirement_intake_list` (newest-first, optional status filter);
`--writable` adds `requirement_intake_submit`, which files a request verbatim (`originalRequest`
is immutable) and submits it immediately. Records are shared with the CLI `/intake` command, the
WebUI REST API (`/api/projects/:projectId/requirement-intakes`), and the SDD interview kickoff —
one project intake store for every surface. The server is a direct adapter over the file-backed
`@wrongstack/requirement-intake` store; it never touches other project state.

The built-in preset (`wstack mcp add requirement-intake`) spawns
`wstack-requirement-intake-mcp --project-root . --writable` from the current working directory;
point `--project-root` at an absolute path when the client cwd is not the project root. See
[`packages/requirement-intake-mcp/README.md`](../packages/requirement-intake-mcp/README.md) and
[`docs/specs/requirement-intake-sdd.md`](./specs/requirement-intake-sdd.md) for details.

## Transports

| Transport | Flag | Reachability |
|---|---|---|
| **stdio** (default) | _(none)_ | A client spawns `wstack mcp serve` as a child process and talks over its stdio. |
| **HTTP** | `--http [--port N] [--host H] [--token T]` | Network-reachable. POST a JSON-RPC request, get the JSON response; `GET /` is a health probe. |

### HTTP security

- Binds to **`127.0.0.1` (loopback) by default** — only processes on the same machine can reach it.
- Binding to any non-loopback host (e.g. `--host 0.0.0.0`) **requires `--token`**; the server refuses to start otherwise, so tools are never exposed to the network unauthenticated.
- When a token is set, every request must send `Authorization: Bearer <token>` (401 otherwise).
- Request bodies are capped at 4 MiB.

## What gets exposed

By default the server applies the same `AutoApprovePermissionPolicy` used for
subagents: read-only tools (`read`, `glob`, `grep`, `fetch`, `search`, `tree`,
`todo`, …) are exposed, while shell/write/edit and any tool declaring a
dangerous capability are **withheld**. This is the safe default for handing your
tools to an external client.

| Flag | Effect |
|---|---|
| _(none)_ | Read-only tools only (safe default). |
| `--yolo` / `--allow-all` | Expose every built-in tool, including `bash`, `write`, `edit`, `exec`, `install`. |
| `--tools a,b,c` | Restrict to a comma-separated whitelist (intersected with the policy above). |
| `--resources path,...` | Expose only these explicitly selected local files via MCP resources. |
| `--prompts path,...` | Expose only these explicitly selected UTF-8 prompt templates. |

No project files or prompt-library entries are exposed automatically. Resource and prompt flags
are explicit allowlists, each selected file is capped at 256 KiB, directories are rejected, and
unlisted neighboring files remain invisible. Prompt files may contain `{{argument}}` placeholders;
each placeholder becomes a required MCP prompt argument.

A withheld tool is invisible in `tools/list` **and** rejected on `tools/call`,
so a client cannot invoke it by guessing the name.

> ⚠️ `--yolo` gives the connecting client the ability to run arbitrary shell
> commands and write files in the server's working directory. Only use it with
> clients you trust, and prefer `--tools` to scope access.

## Wiring into a client

### Claude Desktop / Claude Code

Add an entry to the client's MCP config pointing at the WrongStack binary:

```jsonc
{
  "mcpServers": {
    "wrongstack": {
      "command": "wstack",
      "args": ["mcp", "serve", "--tools", "read,grep,glob,tree,search"]
    }
  }
}
```

The client launches `wstack mcp serve` as a child process and speaks JSON-RPC
over its stdio.

## Protocol

Standard MCP over stdio (protocol `2024-11-05`), newline-delimited JSON-RPC 2.0:

- `initialize` → advertised capabilities for tools and any explicitly selected resources/prompts
- `notifications/initialized` → (no response)
- `tools/list` → `{ tools: [{ name, description, inputSchema }] }`
- `tools/call` `{ name, arguments }` → `{ content: [{ type: "text", text }], isError }`
- `resources/list`, `resources/templates/list`, `resources/read` when `--resources` is present
- `prompts/list`, `prompts/get` when `--prompts` is present
- `ping` → `{}`

Tool errors are returned as `isError: true` content (the connection stays up);
only protocol-level problems produce JSON-RPC `error` envelopes
(`-32700` parse, `-32600` invalid request, `-32601` method not found,
`-32603` internal).

## Internals

- Protocol core + stdio runner: `packages/mcp/src/server.ts`
  (`MCPServer`, `serveStdio`, `toContentBlocks`) — transport-agnostic and
  dependency-free, so it is unit-tested in isolation.
- CLI wiring (registry → host → server): `packages/cli/src/mcp-serve.ts`,
  routed from the `mcp serve` subcommand. Tool calls run through the standard
  `ToolExecutor` (schema validation, output capping, timeouts) against a minimal
  serve-mode `Context`.
