# SAGE Memory — Direct IPC Usage Guide

> Audience: agents and services that are *part of* WrongStack (CLI, TUI, WebUI server, HQ, internal tools, future code in `packages/`).
>
> If you are **outside** WrongStack and connecting to it from a separate process (Claude Desktop, a different agent runtime, a script on another machine), use the **[`@wrongstack/sage-mcp`](../sage-mcp/)** package instead — it speaks JSON-RPC over MCP and is exactly the same backend.

## 1. The architectural rule

WrongStack strictly separates two consumer classes:

| Consumer class | Path to SAGE | Why |
|---|---|---|
| **External** — Claude Desktop, other MCP-aware clients, out-of-process agents | `@wrongstack/sage-mcp` (`packages/sage-mcp/`) — JSON-RPC over MCP | Stable protocol boundary; safe cross-process usage; the MCP layer is a passthrough only |
| **Internal** — `@wrongstack/cli`, `@wrongstack/tui`, `@wrongstack/webui-server`, HQ, in-process agents, scripts running inside the project | `@wrongstack/sage` `ProjectSageMemoryPort` — direct newline-delimited JSON over Unix socket / Windows named pipe | **MCP is never used internally.** Single-owner-of-SQLite invariant preserved by spawning the same project server, not opening a second writer |

This is a deliberate, durable architectural stance. If you find yourself routing an internal subsystem through `MCPServer` or `@wrongstack/mcp`'s client side, **stop** — you are duplicating the SQLite owner and breaking the single-writer invariant.

## 2. Imports

All of the symbols below are exported from `@wrongstack/sage` directly — no deep imports required. (See `packages/sage/src/index.ts`.)

```ts
import {
  // The recommended entry point for any new consumer
  ProjectSageMemoryPort,
  createProjectSageMemoryPort,

  // Type narrowing helpers
  getSageService,
  getSageSurface,
  getSageRetrieval,

  // For generating tool objects that match the existing runtime shape
  // (used today by `packages/runtime/src/tool-registration.ts`).
  createSageTools,

  // Gate: throws if `node:sqlite` is unavailable (Node < 22.5).
  isSqliteAvailable,

  // Fallback for tests and explicit offline recovery only. Production
  // hosts must use `ProjectSageMemoryPort` / `SqliteMemoryPort` exclusively.
  SqliteMemoryPort,
  SqliteSageStore,
} from '@wrongstack/sage';
import type { MemoryPort } from '@wrongstack/core/types';
```

Why the public exports are sufficient: `@wrongstack/sage` re-exports the SAGE service contract types (`SageServiceLike`, `SageSurface`, `SageRetrieverLike`), all `Sage` shape types, and the IPC connection type — anything you'd want is reachable without reaching into `packages/sage/src/...`.

## 3. Lifecycle

```ts
const port = new ProjectSageMemoryPort({
  projectRoot: '/absolute/path/to/project',
  // Optional overrides:
  // directory: '/custom/sage/storage',     // override storage dir (rare)
  // workspaceRoot: '/another/path',
  // clientId: 'my-agent-7',                 // appears in IPC metadata
  // getSessionId: () => 'session-xyz',      // passed into event broadcasts
  // events: new EventBus(),                 // for live memory.* event streams
});

await port.initialize();
// ... do work ...
await port.dispose();
```

Three facts about `initialize()` that matter:

1. **Lazy-spawns the project server** if one isn't already running. The single-owner-of-SQLite guarantee is enforced by the server's `EADDRINUSE`-on-POSIX-or-EADDRINUSE-on-Windows probe + `probe.connect` retry (`packages/sage/src/project-server.ts:506-532`). You never need to spawn the server yourself — instantiate the port and the side effect is correct.

2. **Reuses an existing server** when one is up. Two `ProjectSageMemoryPort` instances for the same `projectRoot` *share* the same SQLite file. This is by design and is what makes the runtime container's `wstack` and a separately-launched `wstack-sage-mcp` coexist correctly.

3. **Throws a precise error on `node:sqlite` unavailability.** If Node is older than 22.5, `port.initialize()` will surface that immediately via `isSqliteAvailable()`. Verify once at startup if you want a fast-fail:

   ```ts
   if (!isSqliteAvailable()) {
     throw new Error('SAGE requires Node >= 22.5 with node:sqlite');
   }
   ```

`dispose()` cleanly closes the IPC socket. The *server* keeps running until its 5-minute idle shutdown (`packages/sage/src/project-server.ts:36`, `:425-430`) — that's intentional, so a second consumer arriving within five minutes doesn't pay cold-start cost.

If you need the server to stop deterministically (rare; tests / CI), use `port.shutdown(reason)`:

```ts
const result = await port.shutdown('test-teardown');
// → { stopped: true, pid: <number>, reason: 'test-teardown' }
```

## 4. The three typed capability surfaces

`ProjectSageMemoryPort implements MemoryPort`. The `MemoryPort` interface has three named capabilities, each tied to a stable id. Code that needs to call SAGE ops should always go through `getSageService(port)` / `getSageSurface(port)` / `getSageRetrieval(port)` to obtain the typed capability, **not** through type-casting or duck-typing.

### 4.1 `getSageService(port)` → `SageServiceLike`

Defined at `packages/sage/src/service-contract.ts:72`. This is the *primary* surface you want for ordinary reads/writes — the same surface that the existing CLI tools (`remember`, `memory_search`, `memory_delete`, etc.) wrap.

The 19 methods on `SageServiceLike`:

| Method | Behavior | Use case |
|---|---|---|
| `remember(text, scope?, metadata?)` | Legacy JSONL-shape entry; honored for backward compatibility with `MemoryStore` (CLI's `/memory forget` / etc.) | Don't use — prefer `rememberSage` below |
| `forget(query, scope?)` | Substring-based soft-delete at a legacy scope | Don't use — prefer `deleteSage` with explicit id |
| `read(scope)` / `readAll()` | String-form legacy export | Not for IPC consumers; use `searchSage` / `retrieveForPath` |
| `consolidate(scope)` / `clear(scope?)` | Legacy cleanup | Not for IPC consumers |
| `list(scope?, limit?)` / `search(query, scope?, limit?)` / `findRelated(text, scope?, limit?)` | Legacy `MemoryStore`-shape queries | Use only when consuming `MemoryStore`; prefer the typed surface |
| `scoreRelevant(context, scope?, limit?)` | Lexical scoring against `MemoryRelevanceContext` | OK for time-pressed retrieval |
| `hygiene(options?, signal?)` | Run hygiene pass | Yes, with `signal` for cancellation |
| `stats()` | Top-level stats | OK |
| `retrieveForPath(opts)` | Path-anchored recall | Yes |
| `searchSage(query, opts?)` | Shape-aware recall (canonical) | **Yes — this is the read you want most of the time** |
| `findRelatedSage(memoryIds, opts?)` | Graph-traverse from seeds | Yes |
| `graphFor(query, maxDepth?, limit?)` | General graph query | Yes |
| `verify(memoryId?, signal?)` | Anchor verification | Yes |
| `listCandidates(includeResolved?)` | Mnemosyne propose-only cleanup queue | Yes |
| `createCandidate(input)` / `resolveCandidate(...)` / `acceptCandidate(...)` / `rejectCandidate(...)` | Mnemosyne review state machine | Yes — Phases 2 / 3 / 4 (`memories:` memory noted 2026-07-18) all use this surface |
| `rememberSage(input)` | Insert a structured `Sage` | **Yes — this is the write you want most of the time** |
| `updateSage(id, patch)` | Patch an existing `Sage` | Yes |
| `deleteSage(id, reason?, options?)` | Soft-delete (status='deleted'), audit-logged | **Yes — but with `force:true` for autonomous callers, see §6** |
| `recoverSage(id, reason?)` | Restore a 'deleted' memory to 'active' | Yes |
| `backfillRecoverable(options?)` | Find recoverable deletions and create fresh active versions | Yes |
| `findMemoriesForFile(filePath, options?)` | Three-bucket file/symbol/mentioned-in lookup | Yes |

### 4.2 `getSageSurface(port)` → `SageSurface`

Defined at `packages/sage/src/service-contract.ts:27`. Same operations plus a few `Sage`-specific ones (`listSage`, `rememberSage`, etc. return the full record shape rather than the legacy `MemoryEntry` shape). Use this when you need `Sage` records back rather than `MemoryEntry`.

### 4.3 `getSageRetrieval(port)` → `SageRetrieverLike`

Defined indirectly in `packages/sage/src/remote-memory-port.ts:30-69`. The capability the runtime middleware (`packages/sage/src/middleware/tool-call-memory.ts`, `createSageToolCallMiddleware`, etc.) consumes. If you are *writing* a custom middleware — almost never needed; you usually want `MemoryInjectorAgent` instead — this is the surface.

## 5. Event stream (live broadcasts)

`ProjectSageMemoryPort` forwards server-side `memory.*` events to a host `EventBus`. If you pass an `EventBus` to the constructor and subscribe, you get a live stream of mutation events:

```ts
import { EventBus } from '@wrongstack/core/kernel';

const events = new EventBus();
events.onPattern('memory.*', (eventName, payload) => {
  // eventName: 'memory.remembered' | 'memory.deleted' | etc.
  console.log('[bus]', eventName, payload);
});

const port = new ProjectSageMemoryPort({ projectRoot, events });
```

The server's broadcast code is at `packages/sage/src/project-server.ts:130-137` and is wired into the project server's idle/active lifecycle. There is exactly one event per op mutation; reads are not broadcast.

## 6. The force/delete gate

This is the load-bearing safety invariant. From `packages/sage/src/tools/memory-tools.ts:332-340`:

> `memory_delete` requires `force: true` to delete any memory. **For non-destructive review, use `memory_candidates({ action: "propose" })` instead.**

In the typed service layer this appears as:

```ts
// Wrong — never does anything
await service.deleteSage('mem_abc');

// Still wrong — provider throws on missing force:
await service.deleteSage('mem_abc', 'cleanup pass');

// Right:
await service.deleteSage('mem_abc', 'user explicitly approved via agent confirm gesture', {
  force: true,
});
```

Mnemosyne is **propose-only** as of 2026-07-18 — autonomous agents must use `createCandidate({...})` and then poll `listCandidates()` rather than calling `deleteSage` at all. See the durable memories for the Phase 3 design contract.

## 7. Use this exact pattern

The single most common shape of "I want to read/write project memory from in-process agent code":

```ts
import {
  ProjectSageMemoryPort,
  getSageService,
  isSqliteAvailable,
} from '@wrongstack/sage';

if (!isSqliteAvailable()) throw new Error('SAGE requires Node >= 22.5');

const port = new ProjectSageMemoryPort({ projectRoot });
await port.initialize();

try {
  const service = getSageService(port);
  if (!service) throw new Error('SAGE service capability missing — wrong port type?');

  // Read
  const hits = await service.searchSage('vector index sync', { limit: 10 });

  // Write
  const saved = await service.rememberSage({
    text: 'Sage memory IPC contract is direct, not MCP',
    kind: 'convention',
    scope: 'project',
    tags: ['sage', 'ipc', 'guide'],
  });
} finally {
  await port.dispose();
}
```

If you find yourself reaching for any other pattern, ask first — the wrong pattern is usually "construct a `SqliteMemoryPort`" (offline-only test path) or "construct a `MCPServer`" (external-clients-only). Both are wrong for the internal-agent case.

## 8. Escape hatch — calling the raw 33-op IPC surface

If you need an op the typed surface doesn't expose (e.g. `importLegacyFiles`, `compactLog`, `getLogStats`, `consolidateSession`, or a future op):

```ts
import { SageProjectServerConnection } from '@wrongstack/sage';

const conn = new SageProjectServerConnection(projectRoot);
await conn.connect();

const result = await conn.call<'importLegacyFiles'>(
  'importLegacyFiles',
  { files: ['/old/jsonl/exports/p1.jsonl', '/old/jsonl/exports/p2.jsonl'] },
  { timeoutMs: 30_000, meta: { clientId: 'legacy-import' } },
  // ^ wait — `call` signature is <O extends SageServerOperationName>
  //   and returns the correct result type. See `project-server-client.ts:155`.
);

await conn.shutdown('done');
```

This bypasses the typed facade. **Do not do this unless you genuinely need an op the surface doesn't cover** — the typed surface is what gets exercised by tests and what gets audit-logged. The 33-op surface is the *protocol*, not the *application interface*.

## 9. What this guide does not cover

- **External / MCP consumer patterns.** See `packages/sage-mcp/`. Don't conflate.
- **WebUI-server SAGE wiring.** See `packages/webui-server/src/server/setup-events.ts` and the durable memory note about `backend-services.ts` injection-tracker gap.
- **Audit log shape.** `readAudit(limit?)` is on the surface; consult `packages/sage/src/types.ts` for the `SageAuditRecord` shape and the audit semantics before depending on it.
- **The knob for going from the typed facade to a fully-typed `Tool` definition.** Use `createSageTools(service)` (`packages/sage/src/tools/memory-tools.ts:34`) to get the canonical `Tool[]` shape — that's what the runtime uses to register tools into `TOKENS.MemoryStore`. If your agent runtime is itself a `ToolRegistry` host, that may be the right factory, not the `SageServiceLike` surface directly.
- **Search / filter / suggest design.** The five existing retrieval primitives (`memory_search`, `memory_for_path`, `memory_for_file`, `memory_graph`, `findRelatedSage`) will be joined by a unified `search` op that bundles filters, ranking, and suggest-on-empty. The 2026-07-28 design eval is at [`docs/search-and-suggest.md`](search-and-suggest.md). Read that before designing or building new external-agent retrieval surfaces.

## 10. A footnote on the SQLite single-writer invariant

This is not a stylistic preference. The SAGE backend has exactly one SQLite file per project and exactly one writer — the project server process. Two clients writing simultaneously would corrupt the WAL. `ProjectSageMemoryPort` and `SqliteMemoryPort` are the only sanctioned handles; both route through `SqliteMemoryPort` to the *same* server process under normal operation.

If you find code that opens `node:sqlite` directly, or that creates a second `SqliteSageStore` against the same storage path, that's the bug. Replace it with `ProjectSageMemoryPort` and the invariant self-restores.
