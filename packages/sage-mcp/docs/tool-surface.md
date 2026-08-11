# `@wrongstack/sage-mcp` — Tool Surface Inventory

> This inventory was generated from the source on 2026-07-28. The source of every fact is the originating `Tool<I,O>` factory in `packages/sage/src/tools/`. Re-derive before trusting.

## 1. The tool surface

`createSageTools(port)` (`packages/sage/src/tools/memory-tools.ts`) produces the full agent memory tool list, including `memory_gather_batch`. Re-derive counts from source after changes — smoke scripts pin the live set.

### 1.1 Read-only tools (`permission:'auto'`, default-exposed)

| Tool | Description | Input | Source |
|---|---|---|---|
| `memory_search` | Lexical/tag/path/anchor search over active memories | `{ query: string, limit?: 1-100, include_stale?: boolean }` | `memory-tools.ts:607-633` |
| `memory_for_file` | Three-bucket retrieval: primary file matches, symbol matches (cursor-aware), mentioned-in matches | `{ path: string, lineStart?: int, lineEnd?: int, limit?: 1-200, showSuperseded?: boolean, showDeleted?: boolean }` | `memory-tools.ts:498-573` |
| `memory_for_path` | Path-anchored retrieval with ancestor walk | `{ path: string, limit?: 1-50 }` | `memory-tools.ts:575-603` |
| `memory_graph` | Traverse the relationship graph from a memory id / path / symbol / search query | `{ query: string, depth?: 1-6, limit?: 1-500 }` | `memory-tools.ts:635-661` |

These four are exposed under the **default policy** (`src/policy.ts:48-49`).

### 1.2 Write-class tools (`permission:'confirm'`, requires `--writable`)

| Tool | Permission | Risk | Mutating | Source |
|---|---|---|---|---|
| `remember` | confirm | standard | yes | `memory-tools.ts:78-197` |
| `forget` | confirm | standard | yes | `memory-tools.ts:199-234` |
| `memory_update` | confirm | standard | yes | `memory-tools.ts:236-290` |
| `memory_delete` | confirm | standard | yes | `memory-tools.ts:292-350` |
| `memory_recover` | confirm | standard | yes | `memory-tools.ts:361-401` |
| `memory_backfill_recoverable` | confirm | standard | dry-run by default | `memory-tools.ts:411-484` |
| `memory_verify` | confirm | standard | yes | `memory-tools.ts:663-682` |
| `memory_hygiene` | confirm | standard | yes | `memory-tools.ts:685-713` |
| `memory_candidates` | confirm | standard | yes | `memory-candidates-tool.ts:45-` |

That's **9 tools added** under `--writable`, for a total surface of **13 tools** with `--writable` and **4 tools** without.

## 2. `memory_delete` — the safety-relevant tool, in detail

The schema (`memory-tools.ts:294-349`):

```ts
{
  id:     string,             // required, validated
  reason: string?,            // optional audit-log reason text
  force:  boolean,            // required to be exactly true
  neverInject: boolean?,      // optional privacy ban flag
}
```

The validation gate (`memory-tools.ts:332-340`):

```ts
validate(input) {
  if (!input.id) return ['id is required'];
  if (input.force !== true) {
    return [
      'force: true is required to delete any memory. ... ' +
      'Pass force: true to authorize; the override is audit-logged. ' +
      'For non-destructive review, use memory_candidates({ action: "propose" }) instead.',
    ];
  }
  return [];
}
```

The adapter calls `Tool.validate` before `Tool.execute` (`src/adapter.ts:125-131`). On validation failure, the adapter returns `{ content: <error message>, isError: true }` and never invokes `execute`.

Output shape on success (`memory-tools.ts:341-349`): `{ deleted: true, id: <input.id> }`.

## 3. `remember` — the audience-aware tool, in detail

The schema (`memory-tools.ts:124-164`): the canonical input shape (over the wire) is `Record<string, unknown>` accepting these fields:

```ts
{
  text:         string,                                       // required
  kind:         enum('fact'|'decision'|'convention'|'preference'|'warning'|'anti_pattern'|'workflow'|'bug_root_cause'|'file_note'|'symbol_note'|'command_note'|'summary'),
  scope:        enum('project'|'user'|'session'|'file'|'symbol')?
  tags:         string[]?,
  anchors:      Array<{ type, path?, symbol?, command?, role? }>? // type ∈ file|directory|symbol|package|command|test|git|agent
  audience:     { roles?: string[], taskTypes?: string[], modes?: string[] }?,
  no_auto_audience: boolean?,
  importance:   number (0-1)?,
  confidence:   number (0-1)?,
  persistence:  enum('permanent'|'long_lived'|'short_lived')?,
  supersedes:   string[]?,
  contradicts:  string[]?,
  // legacy fields:
  type:         ...?,
  priority:     ...?,
}
```

The adapter forces `no_auto_audience = true` on every MCP call (`src/adapter.ts:117-120`). MCP callers must pass `audience` explicitly if they want audience targeting — there is no path by which an MCP `remember` lands in an audience-scoped set without a deliberate caller action.

Output shape: a `Sage` (`@wrongstack/sage`) record returned to the caller as a JSON content block.

## 4. The other write tools

Briefly, all confirmed at the source lines above:

- **`forget`** — substring-based removal at the project scope. Schema: `{ query: string, scope?: 'project-agents'|'project-memory'|'user-memory' }`. Output: `{ removed: <number>, scope: <scope> }`. Use `memory_delete` for exact id-based removal.
- **`memory_update`** — patch one record by id. Schema: `{ id: string, ...UpdateSageInput }` where `UpdateSageInput` is `partial<{ text, tags, kind, anchors, audience, importance, confidence, freshness, status, supersedes, contradicts, force }>`. Validation: at least one field besides `id` is required.
- **`memory_recover`** — restore a `status='deleted'` memory to `active`. Schema: `{ id: string, reason?: string }`. Idempotent; superseded entries resolve to head-of-chain.
- **`memory_backfill_recoverable`** — bulk recover for legacy deletions. Schema: `{ filter?: <scope|kind|time-range|requireText|requireProvenance>, apply?: boolean, reason?: string }`. Default is `dry-run: true` — the report describes what would happen without writing.
- **`memory_verify`** — verify anchor freshness. Schema: `{ memory_id?: string }` (omitting verifies all). Returns `MemoryVerificationResult[]`.
- **`memory_hygiene`** — deduplicate, verify anchors, mark stale, surface review candidates. Schema: `SageHygieneOptions` — `{ retentionDays?, archiveLowConfidenceAfterDays?, verify?, purgeDeletedAfterDays? }`. The last is opt-in JSONL-compaction-only.
- **`memory_candidates`** — Mnemosyne-style review-queue operations. See `memory-candidates-tool.ts` for the exact schema (propose / list / resolve / accept / reject).

## 5. What `tools/list` actually returns

For the **default policy**:
```
1. memory_search
2. memory_for_file
3. memory_for_path
4. memory_graph
```

For the **`--writable` policy**, the same four plus:
```
5.  remember
6.  forget
7.  memory_update
8.  memory_delete
9.  memory_recover
10. memory_backfill_recoverable
11. memory_verify
12. memory_hygiene
13. memory_candidates
```

This 13-tool count under `--writable` is exactly what `scripts/smoke.ts` assertions pin (smoke output line `2/8 tools/list OK (13 tools: ...)`).

## 6. Schema fidelity

Every tool's `inputSchema` is built via `tool-schema-helpers.ts` (objectSchema, stringSchema, numberSchema, enumSchema, stringArraySchema, anchorsSchema, audienceSchema). All schemas declare `type: "object"` at the root with `additionalProperties: false`, satisfying the JSON Schema 2020-12 floor. Empirically pinned by `scripts/smoke.ts` assertion 2: `tools.every((t) => t.inputSchema.type === 'object')`.

## 7. How to verify this inventory

After any change to `packages/sage/src/tools/memory-tools.ts` or `packages/sage/src/tools/memory-candidates-tool.ts`:

```sh
pnpm exec vitest run packages/sage-mcp/tests/policy.test.ts
pnpm exec tsx packages/sage-mcp/scripts/smoke.ts
```

The smoke's `2/8` line lists every tool name in alphabetical order; if your source change adds/removes/renames a tool, the count and the listed names will shift, and you'll see exactly what.
