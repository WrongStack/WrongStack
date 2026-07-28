# @wrongstack/sage-mcp

WrongStack **SAGE Memory** exposed as an [MCP](https://modelcontextprotocol.io/) server. Use it from any MCP-compatible client (Claude Desktop, another agent, an IDE) to read, write, and curate your project's structured long-term memory.

Two operating modes:

| Mode | Entry point | What it does |
|------|-------------|--------------|
| **Standalone** | the `wstack-sage-mcp` binary this package ships | Boots *only* SAGE Memory — no `@wrongstack/cli` needed — and serves it over MCP. Connects to the existing SAGE IPC project server (Unix socket / Windows named pipe) lazily, exactly like the rest of the SAGE ecosystem. |
| **In-process** *(deferred to Phase 4)* | `wstack sage-mcp ...` *inside* the existing CLI | Strictly additive, opt-in only; preserves the rule "*without changing Sage's existing normal behavior*". |

This package does **not** introduce a new database, a new file format, or a new SQLite owner. The single-owner-of-state model in `packages/sage/src/project-server.ts` is preserved exactly: SAGE has one writer per project, and clients attach to it. MCP is one more client shape.

## Install

Built artifacts come from `pnpm -F @wrongstack/sage-mcp build`. The CLI binary lives at `dist/cli.js` and is published as `wstack-sage-mcp`.

```sh
pnpm install
pnpm -F @wrongstack/sage-mcp build
```

## Quick start — Claude Desktop

Save this as your Claude Desktop MCP config (path: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "sage": {
      "command": "wstack-sage-mcp",
      "args": [
        "--project-root",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

Replace `/absolute/path/to/your/project` with the directory where you've been running `wstack`. Restart Claude Desktop; the SAGE tools appear in the tool picker.

### Expose writes to the model

Default policy is **read-only** (`memory_search`, `memory_for_file`, `memory_for_path`, `memory_graph`). For an agent that should also `remember`, `forget`, or `memory_delete`:

```json
{
  "mcpServers": {
    "sage": {
      "command": "wstack-sage-mcp",
      "args": [
        "--project-root",
        "/absolute/path/to/your/project",
        "--writable"
      ]
    }
  }
}
```

Claude Desktop will surface its own confirmation gesture before calling write-class tools. The Sage `force: true` gate on `memory_delete` is preserved at the MCP boundary — see *Safety guarantees* below.

### Loopback HTTP (advanced)

If you want multiple clients to talk to the same SAGE project (e.g. two IDEs, one Claude Desktop, one custom script):

```sh
wstack-sage-mcp \
  --project-root /absolute/path/to/project \
  --http \
  --port 8765
```

Then point any MCP HTTP client at `http://127.0.0.1:8765/`. Non-loopback hosts require `--token`:

```sh
wstack-sage-mcp \
  --project-root /absolute/path/to/project \
  --http --host 0.0.0.0 --port 8765 --token "$(openssl rand -hex 32)"
```

The HTTP transport reuses `serveHttp` from `@wrongstack/mcp` directly; the same loopback-default + token-required gate that `wstack mcp serve` enforces applies here.

## CLI reference

```
wstack-sage-mcp --project-root <path> [options]

Options:
  --project-root <path>   Project root whose SAGE memory should be served (required).
  --storage-dir <path>    Override the SAGE storage directory.
  --stdio                 Use stdio transport (default).
  --http                  Use HTTP transport.
  --port <n>              TCP port for HTTP mode (default 0 = ephemeral).
  --host <h>              Bind host for HTTP mode (default 127.0.0.1; non-loopback REQUIRES --token).
  --token <t>             Bearer token for HTTP mode.
  --writable              Expose standard-tier (write/delete) tools.
  -h, --help              Show this message.
```

## Tool allowlist

| Policy | Tools exposed |
|--------|---------------|
| **Default (read-only)** | `memory_search`, `memory_for_file`, `memory_for_path`, `memory_graph` |
| **`--writable`** adds   | `remember`, `forget`, `memory_delete`, `memory_update`, `memory_recover`, `memory_backfill_recoverable`, `memory_verify`, `memory_hygiene`, `memory_candidates` |

`selectAllowedTools` is implemented at `src/policy.ts` and is fully unit-tested. The model is: `permission === 'deny'` is always excluded; `permission === 'auto'` is exposed under any risk tier when `--writable`; `permission === 'confirm'` is exposed only under `--writable`; `riskTier === 'destructive'` is **never** exposed (no current Sage tool is tagged destructive — this is forward-compatible).

## Safety guarantees

- **`memory_delete` requires `force: true`** — same gate as `packages/sage/src/tools/memory-tools.ts:332-340`. MCP clients calling without `force` receive an `isError: true` JSON-RPC response, not a deletion.
- **`memory_update` validates** that at least one field is supplied.
- **`memory_verify`** mutates anchor state but accepts only known memory ids.
- **Audit log**: deletes are recorded in `readAudit` (use `Sage.audit` capability if you wire one in; tools don't expose this directly).
- **Loopback default for HTTP** — `serveHttp` refuses non-loopback binds without `--token`, matching `wstack mcp serve`.
- **Single-owner-of-SQLite** preserved — the standalone binary connects via `ProjectSageMemoryPort`, which lazily spawns `project-server.js` from `@wrongstack/sage` and never opens its own SQLite handle on a running project.

## Verifying your install

```sh
pnpm -F @wrongstack/sage-mcp tsx scripts/smoke.ts
```

This boots the MCP server in-process and exercises all 8 protocol-level invariants (initialize / tools/list / memory_search / force-gate on `memory_delete` / malformed envelopes / method-not-found / unknown-tool). Exits 0 on full pass, non-zero with a precise message on the first failed assertion. **The smoke is host-independent** — it uses Node `PassThrough` streams instead of child-process spawn, so it works on Windows, Linux, and macOS.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP client (Claude Desktop, custom agent, IDE)                  │
│      ↕ stdio / http                                              │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  wstack-sage-mcp                                                 │
│   • MCPServer.handleMessage  ← from @wrongstack/mcp              │
│   • serveStdio / serveHttp   ← from @wrongstack/mcp              │
│   • createSageMcpToolHost    ← src/adapter.ts                   │
│         listTools = createSageTools(port) filtered by policy    │
│         callTool = Tool.validate → Tool.execute → JSON content  │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  ProjectSageMemoryPort                                            │
│  (reconnecting IPC client; transparently acquires the SAGE       │
│   project server if not already running)                        │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  SAGE project server (existing; packages/sage/src/project-server.ts)  │
│  Unix socket / Windows named pipe — single owner of SQLite       │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  node:sqlite DatabaseSync (WAL)                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Public exports (`@wrongstack/sage-mcp`)

```ts
import {
  createSageMcpServer,    // (port, opts) => MCPServer
  createSageMcpToolHost,   // (port, opts) => MCPServerToolHost
  requireSageService,     // (port) => SageServiceLike; throws if absent
  selectAllowedTools,     // (tools, opts) => filtered tools (for tests / custom policies)
  type SageMcpToolHostOptions,
  type SageMcpPolicyOptions,
  type SageMcpAllowedTool,
} from '@wrongstack/sage-mcp';
```

## Related packages

- `@wrongstack/sage` — implementation owner of memory; provides `createSageTools`, `SqliteMemoryPort`, `ProjectSageMemoryPort`.
- `@wrongstack/mcp` — MCP toolkit; provides `MCPServer`, `serveStdio`, `serveHttp`, `MCPRegistry`, `transport-security`. This package reuses those primitives; it does not extend them.
- `@wrongstack/kanban` — the kanban daemon follows the same single-owner-of-state, many-clients-over-IPC architecture. Same pattern, different data.

## License

MIT — see repository root.
