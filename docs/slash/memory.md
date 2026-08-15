# `/memory` — Structured Project Memory

`/memory` manages the configured `MemoryStore`. SAGE is the memory backend and stores structured, revisioned project knowledge under the gitignored `.wrongstack/memories/` directory. Setting `Sage.enabled: false` does not swap the store — it only turns off automatic context injection and session-end hygiene; explicit `/memory` commands and memory tools keep working.

## Subcommands

| Usage | Effect |
|---|---|
| `/memory [show|list]` | Show active memory through the compatibility view |
| `/memory search <query>` | Search text, tags, paths, symbols, and command anchors |
| `/memory race <query>` | Run the same query through both lexical (SAGE) and semantic (vector) channels; surface the overlap, lexical-only, and vector-only buckets. Makes the value of running both stores side-by-side visible. Falls back to lexical-only when the vector store is not wired. |
| `/memory file <path>` | Show memory attached directly to a file |
| `/memory path <path>` | Include attached ancestor-directory memory |
| `/memory graph <id|path|query>` | Traverse memory/file/symbol/command relationships |
| `/memory remember <text>` | Store a project memory |
| `/memory forget <query> [--exact]` | Delete matching entries; exact mode guards broad deletion |
| `/memory verify [memory-id]` | Verify file, directory, symbol, content-hash, and git anchors |
| `/memory hygiene` | Deduplicate, supersede, stale, archive, and rebuild derived state |
| `/memory candidates [list|all]` | List session-consolidation candidates |
| `/memory candidates accept <id>` | Accept a pending candidate |
| `/memory candidates reject <id> [reason]` | Reject a pending candidate |
| `/memory audit` | Show recent mutation and automated-decision records |
| `/memory import-legacy` | Import legacy project/user `memory.md` files idempotently |
| `/memory stats` | Show status, kind, and graph-edge totals |
| `/memory diagnostics` | Two-system health snapshot — SAGE stats, vector memory stats, embedding cache, and cross-system coverage (mirrored vs standalone entries). Suggests `--vector-sync` when the mirror is empty. |
| `/memory compact` | Ask the active LLM to curate legacy-compatible project entries |
| `/memory clear --force` | Intentionally delete every non-permanent entry; blocked without `--force` and confirmation |
| `/memory audience list [--role <r>] [--task-type <t>] [--mode <m>]` | View role-scoped memories, optionally filtered by role/task/mode |
| `/memory audience remember --role <r> [--task-type <t>] [--mode <m>] <text>` | Store a memory targeted at specific agent types (at least one selector required) |
| `/memory audience search <query>` | Search scoped memories by partial text/role/mode match |
| `/memory audience transfer <from-role> <to-role>` | Bulk re-scope all memories from one role to another |
| `/memory audience clear <memory-id>` | Remove the audience scope from a memory (it becomes general project memory) |

## Audience-scoped memory

Memories can carry an optional **audience** selector (`roles`, `taskTypes`, `modes`) that targets them to specific agent types. When a subagent is spawned, the host queries `retrieveForAudience` with the agent's stable roster role and optional task-type/mode, then injects matching memories into the system prompt **before** the per-spawn override.

Selector semantics: **OR** within a dimension (a memory with `roles: ['reviewer', 'refactor-planner']` matches either), **AND** across dimensions (if both roles and taskTypes are set, both must match). Values are case-insensitive and trimmed.

Audience-scoped memories are **excluded** from ordinary `searchSuper` / `retrieveForPath` by default, so role-specific guidance never leaks into the leader's general turn/tool hints. Explicit search still finds them when `includeAudienceScoped` is set.

The leader's active mode is propagated to spawned subagents as `memoryContext.mode`, so a subagent spawned without its own mode setting inherits the leader's mode for audience matching.

The WebUI Memory view includes an **Audience-Scoped Memory** sidebar panel for browsing, filtering by role, creating, and clearing scope.

## Automatic retrieval and hygiene

Relevant active memory is retrieved on demand and appended to matching read/tree/search/command/edit tool results. A task-aware Memory Injector combines the concrete tool context with live todo/Kanban state, follows graph and shared file/symbol/package/command/tag relationships, prefers durable project facts/references, and measures context pressure before selecting up to 8 diverse hints. New and updated memories also gain bounded direct memory-to-memory edges from shared symbols, paths, packages, commands, and strong topic tags; each edge stores its weight and human-readable structural evidence. The WebUI relationship map queries these persisted edges when a memory is selected, renders related memory records, and lists the exact `why` evidence; TUI exposes the same data through `/memory graph <id|path|query>`. Every injector run emits a UI-only decision trace, including empty runs. “Activated” means a memory crossed the relevance/cooldown gates and was selected; “injected” means it was actually written into the model-visible tool result after the character budget was applied. The compact widgets show matched/injected/filtered plus `ctx` (confirmed in the latest provider request), `pending` (injected since that request), and `left` counts. Full memory text, scores, anchors, reasons, and provider-request-accurate transitions live in the WebUI Context Dashboard and interactive TUI `/context` monitor. A separate bounded lifecycle ledger in those detailed views shows when memories enter, update, merge, recover, exit, or gain a direct memory relationship; delete reasons and relationship evidence remain visible without inflating the normal chat context. Ordinary turn-context injection is off by default and can be explicitly enabled with `Sage.inject.turnContext: true`. Deleted records are storage tombstones for audit/recovery and are never injected; stale records may appear only as warnings after mutation verification. `/clear` always preserves SAGE memory. Each meaningful successful run synchronously consolidates at most five grounded, `long_lived` memories before the response lifecycle completes. Cooldowns, score thresholds, and output caps prevent repeated hints. Write/edit/patch calls re-verify affected anchors; session shutdown runs non-destructive hygiene unless disabled.

Automatic injection is relevance-gated independently from memory quality: importance, confidence, and persistence may rank an already-relevant record but cannot make an unrelated record eligible. Exact path/symbol/command anchors are preferred; lexical-only results require meaningful term evidence and are capped at two per tool result. Graph expansion starts only from a concrete path or exact-anchor seed, requires shared structural evidence, and contributes at most one result. Project-root (`.`) anchors are never universal file matches. Pending todo chatter is excluded from task signals. At 82% context pressure the injector allows at most one memory/600 characters, and at 95% it injects nothing.

CLI, TUI, WebUI, SimpleUI, and Desktop use the same SAGE backend and injection rules. Relative tool paths are resolved from the active working directory before file/directory anchors are matched.

Rich read-only and maintenance tools are also registered: `memory_for_file`, `memory_for_path`, `memory_search`, `memory_graph`, `memory_verify`, `memory_hygiene`, and `memory_candidates`.

Configuration lives under `Sage.storage`, `Sage.inject`, and `Sage.hygiene`; these are benign project-config fields. Providers, endpoints, and executable verification commands cannot be configured from in-project config.

## Storage

- Canonical SQLite database: `.wrongstack/memories/sage.db`
- The same database stores revisions, review candidates, audit history, and graph edges.
- Legacy `memories.jsonl`, `candidates.jsonl`, `audit.jsonl`, and `graph/edges.jsonl` files are imported once and then retained only as recovery backups.

Writes are deduplicated and metadata-merged in WAL-backed SQLite transactions. A project-wide mutation lock keeps concurrent surfaces from creating competing revisions. Graph nodes connect memories to symbols, files, parent directories, sessions, tools, and source records.

Code: `packages/sage/`, `packages/cli/src/slash-commands/memory.ts`.
