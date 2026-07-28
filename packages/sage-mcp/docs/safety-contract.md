# `@wrongstack/sage-mcp` — Safety Contract

> Every claim in this document is the contract under which the package ships. Where the source diverges from this doc, the source is wrong and the doc must be updated — **not** the reverse.

## 1. The guarantees this package makes

| # | Guarantee | Source line | Test that pins it |
|---|---|---|---|
| S1 | `memory_delete` over MCP **requires** `force: true`; missing or `false` returns `isError: true` and never mutates SQLite | `src/adapter.ts:125-131` (validation pass) and `packages/sage/src/tools/memory-tools.ts:332-340` (canonical gate) | `tests/adapter.test.ts` "memory_delete force:true gate survives MCP" — `tests/smoke.ts` 4/8 (smoke) |
| S2 | `memory_update` validates that at least one field is supplied before any partial-update path is taken | `packages/sage/src/tools/memory-tools.ts:276-289` | Inherited from sage; not duplicated here. |
| S3 | Destructive-risk SAGE tools never appear in `tools/list`, regardless of `--writable` | `src/policy.ts:47` (early return if `riskTier === 'destructive'`) | `tests/policy.test.ts` "refuses destructive-tier tools unconditionally" — and the variant with `--writable` |
| S4 | Default tool exposure is read-only — only `permission:'auto'` AND `riskTier:'safe'` tools are visible | `src/policy.ts:48-49` | `tests/policy.test.ts` "default policy exposes only safe + auto tools" |
| S5 | HTTP transport refuses non-loopback binds without a `--token` | Inherited from `packages/mcp/src/server.ts:518-525` (`serveHttp`'s built-in gate); invoked at `src/cli.ts:154-159` with whatever `httpToken` argument was parsed | Inherited test in `@wrongstack/mcp` (`packages/mcp/tests/server.test.ts` covers the gate). |
| S6 | Single-owner-of-state preserved — the standalone binary connects via `ProjectSageMemoryPort` and never opens its own SQLite handle | `src/cli.ts:132-141`; lazies the existing `project-server.js` via `packages/sage/src/project-server-client.ts:454-465` | `scripts/smoke.ts` 8/8 (smoke uses `SqliteMemoryPort` directly because the host's stdin doesn't engage the IPC layer in-process — separate integration concern) |
| S7 | `node:sqlite` availability is checked at construction, not lazily at first call | `src/adapter.ts:66-73` | Behavior: throws a precise error rather than dying mid-protocol. |
| S8 | On any uncaught error inside `Tool.execute`, the result is `isError: true` with the error message; the SQLite state is left to the tool's own transaction semantics | `src/adapter.ts:133-139` | Adapter test path. |
| S9 | `remember` over MCP cannot implicitly tag a memory to any audience role/mode — the user must pass `audience` explicitly | `src/adapter.ts:117-120` (sets `no_auto_audience = true`) | `tests/adapter.test.ts` *"--writable: remember over MCP lands with audience: undefined regardless of caller intent"* — close-the-loop test added 2026-07-28 |
| S10 | Stdio transport: nothing writes to stdout except JSON-RPC responses. All logging goes to stderr. | `src/cli.ts:1-23` (header) and the absence of any `process.stdout.write` in non-stdio-mode paths | The CI gate is implicit: a hostile MCP host that reads stdout as JSON would break if log lines mixed in. |

## 2. What we explicitly do **not** guarantee

- **Cross-project isolation under different `--project-root`s**: `ProjectSageMemoryPort` reads the IPC endpoint keyed by `projectRoot` (`packages/sage/src/project-server-endpoint.ts:25-34`). Two invocations with different `--project-root` connect to different SAGE project servers and never share SQLite. We do not add additional locking; the SAGE side owns that.
- **Audit logging of MCP-mediated deletions**: SAGE's audit log (`readAudit` on the surface) is **not** exposed via MCP. If an audit trail is required, the host should layer one on top of the MCP server.
- **MCP-level request cancellation**: we bind an `AbortController` (`src/adapter.ts:84-85`) but never trigger it. MCP 1.0 has no spec-level `tools/call:cancel`, and triggering mid-flight could leave SQLite half-mutated. We would rather lock the agent's request-thread for the duration of the tool.
- **`--host 0.0.0.0 --token anything` is accepted**: the gate is "token required", not "token strong". Use a 32-byte hex token at minimum.

## 3. The `memory_delete` story, in full

This is the load-bearing safety claim of the package, so it gets its own section.

### 3.1 What `memory_delete` does in SAGE

Defined at `packages/sage/src/tools/memory-tools.ts:292-350`. The schema is:

```ts
{
  id:     string,             // required
  reason: string?,            // audit-log reason text
  force:  boolean,            // REQUIRED: must be true
  neverInject: boolean?,      // soft-delete with privacy ban
}
```

The `validate(input)` function at `packages/sage/src/tools/memory-tools.ts:332-340`:

```ts
validate(input) {
  if (!input.id) return ['id is required'];
  if (input.force !== true) {
    return [
      'force: true is required to delete any memory. ... Pass force: true to authorize; ' +
      'the override is audit-logged. For non-destructive review, use ' +
      'memory_candidates({ action: "propose" }) instead.',
    ];
  }
  return [];
}
```

This is a hard, fail-closed gate. Any caller that does not pass `force: true` gets a validation error back and the tool's `execute` body is **not** invoked.

### 3.2 What the adapter does

`src/adapter.ts:125-131` runs `Tool.validate` *before* `Tool.execute`:

```ts
const validate = tool.validate;
if (typeof validate === 'function') {
  const errors = await validate(callArgs);
  if (Array.isArray(errors) && errors.length > 0) {
    return { content: errors.join('\n'), isError: true };
  }
}
```

The adapter does **not** modify the validation result or bypass it under any circumstance. If `validate` returns an error array, the MCP response is `{ content: <error message>, isError: true }` and `execute` is not called.

### 3.3 What the smoke pins

`scripts/smoke.ts:197-238`:

- Assertion 4 — `memory_delete` without `force: true` → `isError: true`. Result text must mention `/force/i`.
- Assertion 5 — `memory_delete` with `force: true` → success.

If assertion 4 ever regresses, the smoke fails non-zero and the safety contract breaks visibly.

### 3.4 What we do **not** do

- The smoke does not exercise `force:false` (a stringified boolean). `JSON.parse('"false"')` would still produce a truthy check; the gate compares `input.force !== true`. This is correct.
- We do not surface a different tool name for "delete with reasoning" — the only delete path is `memory_delete`. Mnemosyne's propose-only deletion (`memory_candidates({ action: "propose" })`) is a different surface and we don't intend to auto-expose it under MCP.

## 4. The `remember` story (auto-audience containment)

`packages/sage/src/tools/memory-tools.ts:166-178` reads `ctx.meta['agentRole']` and `ctx.meta['mode']` to auto-scope audience targeting:

```ts
const detectedRole = ctx?.meta['agentRole'];       // typeof string
const detectedMode  = ctx?.meta['mode'];            // typeof string
const autoAudience =
  !input.audience && !input.no_auto_audience && (detectedRole || detectedMode)
    ? { roles: [detectedRole], modes: [detectedMode] }
    : input.audience;
```

MCP `MCPServerToolHost.callTool(name, args)` (`packages/mcp/src/server.ts:36-39`) does **not** supply a `ctx`. The adapter fabricates an empty-`meta` Context (`src/adapter.ts:152-165`), so `detectedRole` and `detectedMode` are always `undefined`. Without further intervention, `autoAudience` would be `input.audience` (which is `undefined` if the caller didn't supply it) and `no_auto_audience` would be `undefined` — making the audience null and opt-in.

To eliminate the silent opt-in, the adapter **forces** `no_auto_audience = true` for every `remember` call (`src/adapter.ts:117-120`):

```ts
if (name === 'remember' && callArgs['no_auto_audience'] === undefined) {
  callArgs['no_auto_audience'] = true;
}
```

This means MCP callers who want audience targeting must pass `audience` explicitly. There is no path by which a `remember` over MCP can land in the audience-scoped set without a deliberate, named caller action.

## 5. What fails closed vs. fails open

| Failure | Mode | Why |
|---|---|---|
| `force: true` missing on `memory_delete` | **Fail closed** | `Tool.validate` returns errors and `Tool.execute` is not invoked. |
| `node:sqlite` unavailable | **Fail closed** | `createSageMcpToolHost` throws at construction (`src/adapter.ts:66-73`). |
| `MemoryPort` lacks `SAGE_SERVICE_CAPABILITY` | **Fail closed** | `requireSageService` throws with a precise message. |
| Host runs without `--project-root` | **Fail closed** | CLI exits 2 with banner (`src/cli.ts:125-128`). |
| `Tool.execute` throws | **Fail closed** | Adapter returns `isError: true` with the error message (`src/adapter.ts:133-139`); SQLite transaction semantics remain the tool's responsibility. |
| `MCPServer.handleMessage` sees malformed JSON | **Fail closed** | `MCPServer` returns -32700 / -32600 envelope (`packages/mcp/src/server.ts:121-127`). |
| `--writable` enables writes | **Fail open (intentional)** | The user opted in; the MCP client is expected to surface its own confirm UX before forwarding a `tools/call`. |
| `--http --host 0.0.0.0` without `--token` | **Fail closed** | `serveHttp`'s gate (`packages/mcp/src/server.ts:518-525`) rejects non-loopback binds. |

## 6. Open items

These are not regressions — they're deliberately deferred. Each is an honest admission that more verification could exist.

- **No HTTP path smoke.** The smoke is stdio-only. HTTP-loopback smoke is a Phase 4 item.
- **No load testing of large payloads.** The 4 MiB body cap from `serveStdio` (`packages/mcp/src/server.ts:381`) protects the host; the SAGE side has no documented cap on individual memory text length.

**Closed in this session (2026-07-28):** the auto-audience test gap (Section 4 + S9 row above). Previously asserted by reasoning; now pinned by `tests/adapter.test.ts`'s 8th `it()`. The test calls `remember` over the MCP boundary with an explicit `audience` and asserts the persisted memory carries exactly that audience unchanged.

## 7. How to verify these guarantees yourself

```sh
# 1. Build
pnpm -F @wrongstack/sage-mcp build

# 2. Run vitest suite (catches regressions of the smoke's 4 and the vitest's `memory_delete force:true` assertions)
pnpm exec vitest run packages/sage-mcp/tests

# 3. Run the host-independent smoke (catches MCP-protocol-level regressions)
pnpm exec tsx packages/sage-mcp/scripts/smoke.ts

# 4. Manually inspect the policy decision matrix
cat packages/sage-mcp/tests/policy.test.ts
```

Any drift between this document and the code is the source of the disagreement. When the code wins, update this document. When this document wins, fix the code.
