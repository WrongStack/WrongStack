# `@wrongstack/sage-mcp` — Architecture

> Source-of-truth documentation. Every claim in this document cites a file and line range that backs it. If the source changes, this document should change with it — do not let the doc drift.

This package is a thin adapter that exposes WrongStack **SAGE Memory** as an [MCP](https://modelcontextprotocol.io) server. It does not own any state — every byte of memory lives in the existing SAGE IPC project server (`packages/sage/src/project-server.ts`). The package's role is translation: from SAGE's `Tool<I, O>` shape (`packages/core/src/types/tool.ts:93`) to MCP's `MCPServerToolHost` shape (`packages/mcp/src/server.ts:36-39`).

## 1. Module layout

```
packages/sage-mcp/
├── src/
│   ├── index.ts        (26 lines)   — public exports
│   ├── version.ts      (35 lines)   — version reported via MCP `initialize`
│   ├── policy.ts       (61 lines)   — tool allowlist
│   ├── adapter.ts     (177 lines)   — host adapter + `MCPServer` factory
│   └── cli.ts         (193 lines)   — standalone `wstack-sage-mcp` binary
├── tests/
│   ├── policy.test.ts              — pure function tests, 7 cases
│   ├── cli.test.ts                 — parseArgs tests, 9 cases
│   └── adapter.test.ts             — server-roundtrip tests, 7 cases
└── scripts/
    └── smoke.ts                    — host-independent end-to-end smoke
```

## 2. Public exports — `src/index.ts`

The package's public surface is exactly four runtime symbols plus two type exports:

| Export | Source line | Purpose |
|---|---|---|
| `createSageMcpServer(port, opts)` | `src/index.ts:15` → `src/adapter.ts:167-176` | Returns a configured `MCPServer` ready to hand to `serveStdio` / `serveHttp`. |
| `createSageMcpToolHost(port, opts)` | `src/index.ts:16` → `src/adapter.ts:62-150` | Returns the lower-level `MCPServerToolHost` if you want to compose the server yourself. |
| `requireSageService(port)` | `src/index.ts:17` → `src/adapter.ts:51-60` | Resolves and validates the `SAGE_SERVICE_CAPABILITY` from any `MemoryPort`; throws a precise error if absent. |
| `selectAllowedTools(tools, opts)` | `src/index.ts:21` → `src/policy.ts:40-60` | Pure allowlist filter — exposed primarily for testing and for hosts that want to build their own MCP server with a custom policy. |
| `SERVER_INFO` | `src/index.ts:25` → `src/version.ts:34` | The `{ name, version }` object reported to MCP clients in `initialize`. |
| Types `SageMcpToolHostOptions`, `SageMcpPolicyOptions`, `SageMcpAllowedTool` | `src/index.ts:18,22,23` | Public type exports only. |

There is **no re-export** of `wstack-sage-mcp` itself — that is consumed via the `bin` field in `package.json`, not as a library symbol (`src/index.ts:11-12`).

## 3. Sequence: from CLI to JSON-RPC response

Walking the production path end-to-end so each step is verifiable:

1. **Spawn** — A user runs `wstack-sage-mcp --project-root /x [--writable] [--http ...]`. The `bin` field in `package.json` resolves to `dist/cli.js` post-build (`scripts/build-package.mjs:204-208` registers the build profile).
2. **`parseArgs`** — `src/cli.ts:71-117` parses argv. Unknown flags are intentionally ignored (`src/cli.ts:111-113`) for forward-compatibility.
3. **Required-flag gate** — `src/cli.ts:121-129`: if `--help` exits 0; if `--project-root` is missing, prints the banner to stderr and exits **2**.
4. **`ProjectSageMemoryPort` constructed** — `src/cli.ts:131-135`. The `--storage-dir` flag is wired through only if present (`src/cli.ts:134`).
5. **Lazy IPC attach** — `await port.initialize()` at `src/cli.ts:141` triggers `SageProjectServerConnection.connectWithElection` (`packages/sage/src/project-server-client.ts:255-275`), which tries the existing socket/pipe and, on `EADDRINUSE`/empty, spawns `project-server.js` detached. The connection logic is **not** reimplemented in this package; we delegate to it.
6. **`createSageMcpServer(port, { writable })`** — `src/cli.ts:151` builds an `MCPServer`. Internally this calls `createSageMcpToolHost` (`src/adapter.ts:171`), which throws on missing `node:sqlite` (`src/adapter.ts:66-73`, the same gate as `packages/runtime/src/container.ts:139-144`), then resolves the SAGE service capability (`src/adapter.ts:75`, `src/adapter.ts:51-60`).
7. **Transport** — `serveHttp(server, ...)` (HTTP, `src/cli.ts:154-159`) or `serveStdio(server)` (default, `src/cli.ts:172`).
8. **Per request** — `MCPServer.handleMessage` (`packages/mcp/src/server.ts:113-150`) parses the JSON envelope, dispatches via `dispatch` (`packages/mcp/src/server.ts:154-239`), and for `tools/call` calls `host.callTool(name, args)` (`src/adapter.ts:105-148`).

## 4. The adapter — `src/adapter.ts`

The adapter is the only part of the package that does *interesting* work. Its responsibilities, in order:

### 4.1 Capability resolution — `src/adapter.ts:51-60`

```ts
export function requireSageService(port: MemoryPort): SageServiceLike {
  const service = getSageService(port);
  if (!service) {
    throw new Error('SAGE MCP: the supplied MemoryPort does not expose the SAGE service capability. ...');
  }
  return service;
}
```

`getSageService` is from `@wrongstack/sage` and goes through `MemoryPort.getCapability(SAGE_SERVICE_CAPABILITY)` (`packages/sage/src/memory-port.ts:37`). The same lookup is used by the runtime container at `packages/runtime/src/container.ts:131-152`, which binds the IPC port for the existing CLI's tools. **Failure mode** (missing capability) is a precise human-readable error rather than a hung `null` chain — verified by reading `packages/runtime/src/container.ts:131-152` which throws if `isSqliteAvailable()` is false.

### 4.2 SQLite availability check — `src/adapter.ts:66-73`

Throws if `isSqliteAvailable()` is false. SAGE requires Node ≥ 22.5 with `node:sqlite`. Failing fast at construction beats hanging mid-protocol when the first tool call lands.

### 4.3 Tool discovery and policy filter — `src/adapter.ts:75-78`

```ts
const service = requireSageService(port);
const allTools: Tool[] = createSageTools(service);
const allowed = selectAllowedTools(allTools, opts);
const allowedByName = new Map<string, Tool>(allowed.map((entry) => [entry.name, entry.tool]));
```

`createSageTools(port)` returns the 13-tool surface from `packages/sage/src/tools/memory-tools.ts:34-50`. The map name → `Tool` is built once at construction so each `callTool` is O(1), not O(n).

### 4.4 Synthetic `Context` — `src/adapter.ts:152-165`

MCP `MCPServerToolHost.callTool(name, args)` (`packages/mcp/src/server.ts:36-39`) does not accept a `Context`. SAGE's `Tool.execute(input, ctx, opts)` does. We fabricate a minimal `Context`:

```ts
return {
  systemPrompt: [],
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  allowOutsideProjectRoot: false,
  model: 'sage-mcp',
  tools: [],
  meta: {},  // empty → no role/mode auto-audience detection
} as unknown as Context;
```

`meta` is intentionally empty so that the `remember` tool's auto-audience logic (`packages/sage/src/tools/memory-tools.ts:166-178`, reading `ctx.meta['agentRole']`) yields `undefined`. The adapter then forces `no_auto_audience = true` on every `remember` call (`src/adapter.ts:117-120`), making audience targeting deterministic and opt-in for MCP callers.

### 4.5 `listTools` — `src/adapter.ts:94-103`

Maps each `SageMcpAllowedTool` to an `MCPServerTool`:

```ts
allowed.map(({ name, tool }) => ({
  name,
  ...(tool.description ? { description: tool.description } : {}),
  inputSchema: jsonSchemaToObject(tool.inputSchema),
}));
```

`JSONSchema` is permissive at the boundary (`packages/core/src/types/tool.ts:44-52`: index signature `[k: string]: unknown`), so it satisfies MCP's `Record<string, unknown>` contract with a single cast (`src/adapter.ts:87-92`).

### 4.6 `callTool` — `src/adapter.ts:105-148`

Five-step pipeline for each invocation:

| Step | Lines | Behavior |
|---|---|---|
| 1. Look up | `106-112` | Unknown tool name → `isError: true` with content `"Tool \"<name>\" is not exposed by this SAGE MCP server"`. |
| 2. For `remember`, force `no_auto_audience = true` | `117-120` | Detects the auto-audience call site inside the sage `remember` factory (`packages/sage/src/tools/memory-tools.ts:166-178`). MCP callers can't supply a `ctx.meta.agentRole`. |
| 3. Run `Tool.validate(input)` if present | `125-131` | `Tool.validate` is the canonical safety gate (`packages/sage/src/tools/memory-tools.ts:332-340` for `memory_delete force:true`). Validation errors become `isError: true` with newline-joined messages. |
| 4. Run `Tool.execute(input, ctx, { signal })` | `133-139` | Throws → `isError: true` with `error.message`. Otherwise the output becomes the MCP `content`. |
| 5. Coerce to content block | `146-147` | Strings pass through; everything else is handed to `MCPServer.toContentBlocks` (`packages/mcp/src/server.ts:303-316`) to wrap in `{type:'text', text:string}` blocks. |

The signal here (`ac.signal` at `src/adapter.ts:84-85`) is bound to an `AbortController` that is never triggered. That is **deliberate**: MCP 1.0 has no spec-level cancellation for `tools/call`, and an aborted signal mid-execute would surface as a half-completed mutation on the underlying SQLite. Pending: Phase 4 work to thread `request.id` to the controller.

### 4.7 `createSageMcpServer` — `src/adapter.ts:167-176`

Trivial:

```ts
const host = createSageMcpToolHost(port, opts);
return new MCPServer({
  host,
  serverInfo: { name: 'wrongstack-sage-mcp', version: SERVER_INFO.version },
});
```

`serverInfo.version` is read live from `package.json` (`src/version.ts:22-26`) so that bumping the version requires no code change.

## 5. The policy — `src/policy.ts`

`selectAllowedTools(tools, opts)` is the load-bearing rule for everything `MCPServer` exposes via `tools/list`. The decision matrix is implemented at `src/policy.ts:46-58`:

```
                          | permission:auto       | permission:confirm      | permission:deny
─────────────────────────────────────────────────────────────────────────────────────────────────────────
riskTier:safe             | default                | default+--writable only | never
riskTier:standard         | default+--writable     | default+--writable only | never
riskTier:destructive     | never                  | never                    | never
─────────────────────────────────────────────────────────────────────────────────────────────────────────
```

The actual sage tool inventory (read from `packages/sage/src/tools/memory-tools.ts` during this work):

- **Read-only (`permission:'auto'`, `riskTier:'safe'`)** — `memory_search`, `memory_for_file`, `memory_for_path`, `memory_graph` (file-annexed in `memory_candidates`).
- **Write-class (`permission:'confirm'`)** — `remember`, `forget`, `memory_delete`, `memory_update`, `memory_recover`, `memory_backfill_recoverable`, `memory_verify`, `memory_hygiene`.
- **No `riskTier:'destructive'`** sage tools exist today, so the destructive row is forward-compatible only.

Per the docstring at `src/policy.ts:15-22`, MCP has no UI confirm flow, so the MCP client (e.g., Claude Desktop) is expected to surface its own confirmation gesture before calling a write-class tool. The SAGE-side `Tool.validate` gate (`packages/sage/src/tools/memory-tools.ts:332-340`) remains the canonical safety surface and is preserved at the boundary by `src/adapter.ts:125-131`.

## 6. The CLI — `src/cli.ts`

### 6.1 Exit-code contract

| Exit code | Trigger | Source line |
|---|---|---|
| `0` | `--help`, or normal exit after stdio EOF / `SIGTERM` / `SIGINT` | `src/cli.ts:123, 168, 178` |
| `2` | `--project-root` missing | `src/cli.ts:125-128` |
| `3` | `ProjectSageMemoryPort.initialize()` failed (cannot attach to SAGE project server) | `src/cli.ts:142-148` |
| `1` | Any other unexpected error caught at `main()` level | `src/cli.ts:187-191` |

### 6.2 Stdout / stderr discipline

The CLI follows the same channel discipline as `packages/mcp/src/server.ts:344`'s `serveStdio` (`src/cli.ts:26-30`):

- **stdout**: only JSON-RPC responses (in `stdio` mode) or `--help` text (when requested). Never log lines.
- **stderr**: all human-readable output — the "ready at" banner, MCP `warn` lines via `serveHttp`'s `logger` (`src/cli.ts:158`), and any startup errors.

This matters because an MCP host that reads the child's stdout as JSON-RPC must not see stray logs. `mcp-serve.ts:179-214`'s `makeServeContext` documents the same constraint.

### 6.3 Argument validation

`parseArgs` is exported (`src/cli.ts:71`) so it can be unit-tested without spawning the binary — see `packages/sage-mcp/tests/cli.test.ts`. The unit-test surface covers defaults, every flag, unknown-flag tolerance, and combined-flag round-trips.

## 7. Smoke harness — `scripts/smoke.ts`

The smoke boots the MCP server in-process with `PassThrough` streams and exercises 8 invariants. The non-obvious design point is at `scripts/smoke.ts:39-71` (`sendAndRead`): the listener on `stdout` is attached **before** `stdin.write(...)` is called. PassThrough is async-flushed, so a listener registered after the write loses the data event. This is documented as a durable convention for next time anyone writes an MCP service host in this repo.

The 8 assertions and what each one pins:

| # | Assertion | Source line | Behavior pinned |
|---|---|---|---|
| 1 | `initialize` protocolVersion, serverInfo | `scripts/smoke.ts:131-150` | MCP handshake shape |
| 2 | `tools/list` returns ≥4 tools with `type:"object"` schemas | `scripts/smoke.ts:153-175` | JSON Schema 2020-12 baseline |
| 3 | `memory_search` returns the seeded memory | `scripts/smoke.ts:178-194` | Tool.execute round-trip |
| 4 | `memory_delete` without `force:true` returns `isError:true` | `scripts/smoke.ts:197-214` | **Safety gate at MCP boundary** |
| 5 | `memory_delete` with `force:true` succeeds | `scripts/smoke.ts:217-238` | Authorized deletion works |
| 6 | Malformed envelope returns -32700 or -32600 | `scripts/smoke.ts:241-256` | JSON-RPC error contract |
| 7 | Unknown method returns -32601 | `scripts/smoke.ts:259-268` | JSON-RPC method-not-found |
| 8 | Unknown tool returns `isError:true` | `scripts/smoke.ts:271-282` | Adapter refusal |

## 8. Public surface and stability

Stable API (this iteration):

- `createSageMcpServer(port, opts)` — the canonical entry.
- `createSageMcpToolHost(port, opts)` — for hosts that want to compose.
- `requireSageService(port)` — already-public utility.
- `selectAllowedTools(tools, opts)` — re-exported for parity with `mcp`'s `wstack mcp serve`.

Internal only:

- `parseArgs(argv)` — exported *only* for tests, not part of the public API.
- `SERVER_INFO` — internal; the version it reports is the contract, not the symbol.

If you change the JSON-RPC serverInfo name, MCP clients will see a different identity in `initialize`. If you change the schema of any tool, MCP clients will see different `inputSchema`. Both ripple outward — version with care.
