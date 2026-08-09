# SAGE Memory System — Deep Analysis & Recommendations

Date: 2026-08-08 · Scope: analysis only, no code changes · Evidence: source-verified against `packages/sage`, `packages/core`, `packages/runtime`, `packages/cli`, `packages/tui`, `packages/webui`, `packages/webui-server`

---

## 1. Current state assessment

### 1.1 The memory store (`memoryStore`)

SAGE is the **only** memory backend (the legacy JSONL backend was removed; the JSONL compatibility fallback was deleted). The store is a single SQLite database owned by a **detached per-project daemon** (`packages/sage/src/project-server.ts`), Node built-in `node:sqlite` (Node ≥ 22.5, required — `packages/runtime/src/container.ts:151-156` throws without it).

| Layer | Location | Role |
|---|---|---|
| `SqliteSageStore` | `packages/sage/src/sqlite-store*.ts` | Storage engine: schema, search, retrieval, hygiene, graph, candidates, audit |
| `SqliteMemoryPort` | `packages/sage/src/memory-port.ts:69` | In-process `MemoryPort` wrapping the store; exposes 3 SAGE capabilities |
| `ProjectSageMemoryPort` | `packages/sage/src/remote-memory-port.ts:73` | Production host port — proxies every op over IPC to the daemon |
| `createProjectSageMemoryPort` | `memory-port.ts:317` | Selects remote (production) vs inline (`WRONGSTACK_SAGE_INLINE=1`, Vitest, `NODE_ENV=test`) |
| Runtime container | `packages/runtime/src/container.ts:157-164` | Binds `TOKENS.MemoryStore` **and** `TOKENS.MemoryPort` to one port instance |

The daemon is the **sole owner of SQLite**; hosts hold IPC ports and can never silently open a competing writable backend (single-writer invariant, no split-brain). Legacy JSONL data is imported by the daemon on first open.

### 1.2 IPC binding (runtime container connection)

- **Transport:** per-project Unix socket / Windows named pipe (`sageProjectServerEndpoint`); one daemon per project, elected by bind; EADDRINUSE probe → verify-healthy → exit.
- **Protocol:** `SAGE_PROJECT_SERVER_PROTOCOL_VERSION`; framed JSON-lines messages (`request`/`response`/`event`/`hello`/`cancel`/`shutdown`) — `project-server-protocol.ts`.
- **Auth (WS-028, implemented):** per-process 16-byte `authToken` minted at startup, persisted only to owner-only `server.json` (0o600), **required on every `request` and `shutdown` message**; per-connection `clientId` nonce assigned server-side; audit log never trusts client-supplied identity. `updateSage` over IPC requires `force: true` for `status:'deleted'` patches (dispatch-layer gate, `project-server.ts:384-394`). `importLegacyFiles` enforces project-root containment with realpath.
- **Events:** the daemon subscribes to `memory.*` on its internal EventBus and broadcasts to every client (`project-server.ts:197-216`), stripping server-only secrets; write-buffer cap 8 MB per client.
- **Ops surface:** ~40 operations covering legacy `MemoryStore` shape, the typed surface (list/listPage/get/remember/update/delete/graph/verify/hygiene/candidates/recover/backfill/findMemoriesForFile/readAudit), retrieval (retrieveForPath/searchSage/findRelatedSage/retrieveForAudience), feedback counters (recordInjection/recordUse), unified search, and session consolidation.
- **Lifecycle:** idle-stop after 5 min (`WRONGSTACK_SAGE_SERVER_IDLE_MS`), shared-heap watchdog, ordered `store.dispose()` (drain mutation queue → close), metadata removal before endpoint release (WS-059 ordering).

### 1.3 TUI access points

The TUI **never constructs a store** — it receives `memoryStore` as an `AppProps` prop (`packages/tui/src/app-props.ts:692`, threaded via `run-tui.ts:548`).

- `/memory` slash command (`memory-slash.ts`): show/list, search, file/path, for-file, graph, gather, remember, update, delete, forget, hygiene, verify, candidates, triage, audit, stats, audience — all via `getSageSurface(memoryStore)`.
- Memory context monitor: `use-tui-environment-state.ts` reads record totals from the store, subscribes to `memory.accepted`; `memory-context-monitor.ts` consumes `memory.context_snapshot` events to show active/entered/exited memories per request.
- Injection display: `SageMemoryBlock` renders a magenta-bordered `🧠 SAGE MEMORY INJECTED · {toolName}` panel, parsed by `sage-output-format.ts` from the `--- SAGE: ... ---` tool-result suffix (canonical parser in `packages/core/src/utils/sage-output-block.ts`).

### 1.4 WebUI access points

The WebUI **never constructs a store** — it receives backend WebSocket data only.

- Server handlers (`packages/webui-server/src/server/memory-handlers.ts`): `memory.list` (chat `/memory`), `memory.sage.list`, `memory.sage.listPage` (paginated, status-filtered, cursor-based), `memory.sage.get`, `memory.sage.graph`, `memory.sage.update`, `memory.sage.remember`, `memory.sage.delete`, `memory.sage.recover`, `memory.sage.candidateResolve`, `memory.sage.backfillRecoverable`, `memory.sage.forFile` — all via `getSageSurface(memoryStore)`.
- Event bridge: `setup-events.ts:977` broadcasts every `memory.*` event as `memory.event`; tool events carry `e.sage` lines (injection evidence) rendered as memory cards, never folded into tool output.
- Client: `lib/ws-client-actions.ts` + `hooks/useWebSocket.ts`; stores `memory-injector-store.ts`, `memory-lifecycle-store.ts`; components `MemoryManager/*` (list, detail, graph, editor, drawer, filters, lifecycle trace), `ContextMemoryMonitor`, `AudienceMemoryPanel`, `MemoryInjectorPanel` (via ContextDashboard).
- Server boot: standalone server builds the container (`createDefaultContainer`) and threads `memoryStore` through pre-context services → `createAgentServices`; the CLI's embedded server injects via `opts.services`.

### 1.5 Memory types currently stored

**Kinds (13)** — `types.ts:33-46`: `fact`, `decision`, `convention`, `preference`, `warning`, `anti_pattern`, `workflow`, `bug_root_cause`, `file_note`, `symbol_note`, `command_note`, `summary`, `memory_review`.

**Scopes (5)**: `project`, `user`, `session`, `file`, `symbol`. **Persistence classes (3)**: `permanent` (hygiene never touches), `long_lived` (default), `short_lived` (+ `expiresAt` TTL). **Status (6)**: `active`, `stale`, `superseded`, `contradicted`, `archived`, `deleted`. **Context policy**: `contextPolicy:'never'` bans injection. **Audience**: `{roles, taskTypes, modes}` gating automatic injection (`retrieveForAudience`). **Anchors (8 types)**: file, directory, symbol, package, command, test, git, agent. **Sources**: user, session, tool_result, project_instruction, file, test, command, legacy_memory.

**Prompt memory** (the "memory used to shape prompts"):
1. **Prompt enhancer** (`packages/core/src/execution/prompt-enhancer.ts`): `buildRefinerMemoryContextSection` feeds up to 6 `scoreRelevant`/`search` entries from `project-memory` + `user-memory` into the one-shot refiner as "Relevant project memory" — used when the user enables prompt refinement.
2. **Static system-prompt section** (`core/src/core/system-prompt-memory-skills.ts` `buildMemoryAndSkills`): `# Relevant Memory` via `scoreRelevant({currentTask:'', toolNames})`. The runtime container sets `injectMemory: false` by default so the SAGE turn middleware owns injection (single channel, no double injection); the static path remains for callers that opt in.
3. **Session consolidator** (`core/src/storage/memory-consolidator.ts` `SessionMemoryConsolidator`, registered in `backend-services.ts:457-465`): after successful sessions (≥1 iteration), an LLM produces **add-only** operations → `rememberSage` with kind/tags/importance/confidence/`persistence:'long_lived'`/anchors (normalized, secret-redacted commands)/`sources:[{type:'session'}]`. Add-only by design (2026-07 mass-deletion postmortem).
4. **Agent tools** (`packages/sage/src/tools/memory-tools.ts`): `remember`, `memory_search`, `memory_for_file`, `memory_for_path`, `memory_graph`, `memory_candidates`, `memory_verify`, `memory_hygiene`, etc. Write-class tools require `permission:'confirm'`; read-class are `auto`.

### 1.6 Indexing

- **B-tree indexes**: status, kind, scope, `importance DESC`, `updated_at DESC`, `(status, importance, updated)`, `(status, updated, id)` (cursor pagination).
- **FTS5**: `memories_fts(text, tags, audience)` with AFTER INSERT/UPDATE/DELETE triggers; LIKE fallback when FTS5 unavailable.
- **Graph**: `edges(from_node, to_node, relation, weight, created_at)` with from/to/to_relation indexes; relations incl. `about_file|directory|symbol|package|command|agent`, `supersedes`, `contradicts`, `related_to`, `same_topic`, `derived_from`, `validated_by`, `invalidated_by`. Unified MAX-weight convergence policy (2026-08-02).
- **Candidates**: `candidates(id, data, status, created_at, updated_at, canonical_text)`.
- **Audit log**: capped at 1000 rows, pruned every 256 inserts.
- **Unified search** (`sqlite-store-search.ts`): absolute scores — FTS hits sigmoid(bm25) × (0.75 + 0.25·metadata); non-FTS additive 0.6·recency + 0.4·metadata over a 90-day window; session isolation; audience filters.
- **File retrieval** (`findMemoriesForFile`): three buckets (primary/symbol/related) with `matchedVia` (`scope_file`, `anchor_file`, `mention`, …) and `matchStrength` for the file drawer.

### 1.7 Lifecycle

```
rememberSage (validate → near-dup merge at write → anchors/edges sync → audit)
  → active
      ├─ mutation verify (verifyOnMutation / autoOnFileChange): deep anchor verify → stale
      ├─ periodic hygiene (autoAfterSession, 1h throttle):
      │     existence-only anchor check → stale/verified + lastVerifiedAt
      │     exact-dup + SimHash near-dup → superseded (keeper inherits metadata)
      │     negation-cue contradiction pairs → 'investigate' candidates
      │     retention rules → memory_review candidates (delete/archive/investigate)
      │     session GC (7d default) → immediate soft-delete
      │     opt-in purgeDeletedAfterDays → physical DELETE of old tombstones
      ├─ on-demand deep verify (/memory verify): content hash, symbol presence,
      │     command resolution, git blob hash (batched `git hash-object`) → verified/stale
      └─ review: candidates accepted (delete) / rejected (keep) / updated / merged
            → deleted (soft) → recoverSage / backfillRecoverable (new active version, supersedes link)
```

- **Feedback counters**: `injectionCount` / `useCount` via `recordInjection` / `recordUse`; `InjectionTracker` (2 h TTL, 500 entries, token-overlap match ≥0.5 with 3-token floor, consume-once) closes the usefulness loop; telemetry `memory.injector_run` (per-run gates, scores, rejected reasons) and `memory.context_snapshot` (active/entered/exited per request).
- **Never auto-deletes project memories**: hygiene only creates review candidates; the user/LLM decides via `memory_delete`/`memory_update`/ReviewQueue. `permanent` memories are exempt from all retention.

---

## 2. Additional memory types to consider

| Candidate type | Rationale | Scope | Access model |
|---|---|---|---|
| **Tool-call results (durable outcomes)** | `sources.type:'tool_result'` exists but only as provenance; the *outcome* (exit code, key output shape, "this worked") is not stored. Commands that actually build/test the project are among the highest-value facts. | `project` · kind `command_note`/`workflow` | Auto-capture via a tool-result middleware hook (opt-in) with command anchors + redaction; retrievable via `retrieveForPath`/`searchSage`; reviewed by hygiene like any memory |
| **Error patterns → root cause → fix** | Recurring build/test/runtime errors cost real time; a signature-indexed fix beats re-debugging. | `project` · kind `bug_root_cause`/`anti_pattern` | New extraction trigger keyed on tool-error events (error string family); `importance` by recurrence count; inject on matching error text (error-aware injection) |
| **User preferences (workflow-level)** | Kind `preference` exists; but preferences set in `/settings`, UI toggles, and review feedback are not persisted into SAGE automatically. | `user` scope | Write from the settings/UI layer through the runtime container's IPC binding (`rememberSage`); `audience` on future sessions |
| **Cross-session context / session digests** | `SessionMemoryConsolidator` covers durable facts; there is no *summary* of what a session achieved, decided, or left undone. | `session` scope (ownerSessionId) + `expiresAt` | `summary` kind with `expiresAt` (7–30 d); owned-session isolation already enforced in retrieval; surfaced to the same session on resume |
| **File/content references with content hashes** | `gitBlobHash`/`contentHash` anchors exist but deep verification is on-demand only; a memory stays active when its file *changes* (only *vanishing* files stale it in hygiene). | `file`/`symbol` scopes, `file_note`/`symbol_note` | Capture `gitBlobHash` at write; verify on save/checkout (below); stale-on-content-change closes the "edited but not gone" gap |
| **Codebase knowledge (index-coupled)** | `symbol_note` is stored, but SAGE is not coupled to the codebase index (renames orphan anchors). | `project`, `symbol` anchors | On symbol rename/delete (codebase-index events), emit anchor-update candidates; `test` anchors can carry "this test covers X" |
| **Agent/role operational knowledge** | Audience-scoped memories exist; operational guidance (tool config quirks, rate-limit behavior) is not systematically captured. | `project` + `audience.roles` | `audience`-scoped `warning`/`workflow`; injected only into matching roles — keeps leader/subagent contexts clean |
| **Task/Kanban outcome knowledge** | `taskAware` injection reads live todos, but completed-task outcomes ("what worked on this board/task type") are not stored. | `project` · kind `workflow` | From task-completion events (Kanban Done), remember distilled outcomes with task-type tags; searchable by future tasks of the same type |
| **Security/denial patterns** | Denied tool calls, path-guard rejections, secret-scrubber hits are today only logs. | `project` · kind `warning`/`anti_pattern` | Capture from permission-policy events; `contextPolicy:'never'` on sensitive content; audience-scoped to security roles |
| **Fleet/coordination knowledge** | Agent roster behavior, mailbox etiquette, cross-agent handoff conventions. | `project` + `agent` anchors/audience | `agent` anchor type exists; write from coordination events (mailbox, fleet status) — inject into leader sessions only |

---

## 3. Gap analysis

### 3.1 WebUI-server SAGE memory feedback gap (`backend-services.ts`)

**Verified finding: the gap described (missing shared `InjectionTracker`, event-aware tool-result middleware, turn-middleware tracker/session wiring, context-monitor middleware) is already CLOSED in the current source.** `packages/webui-server/src/server/backend-services.ts:230-291` constructs:

- one shared `sageInjectionTracker` (`new InjectionTracker()`, line 239) used by **both** the tool-call middleware and the (opt-in) turn middleware — cross-path use attribution works;
- `createSageToolCallMiddleware` with `tracker`, `events`, `getSessionId` (lines 241-263);
- `createSageTurnMiddleware` (opt-in, `Sage.inject.turnContext === true`) with the same `tracker` + `getSessionId` (269-280);
- `createSageContextMonitorMiddleware` with tracker/events/session (284-290), emitting `memory.context_snapshot` per provider-bound request;
- `SessionMemoryConsolidator` (457-465) and shutdown hygiene (start-webui.ts:1049-1061).

This mirrors `packages/cli/src/wiring/sage.ts`. **Remaining divergences (the real residual gap):**

1. **`relationFloor` is not forwarded** to the tool-call middleware (CLI passes `cfg?.inject?.relationFloor`). WebUI silently falls back to `MIN_RELATION_STRENGTH = 0.85`. Identical default, but an operator who configures `Sage.inject.relationFloor` sees it honored in the CLI and ignored in the WebUI server.
2. **`metadataWeight` is not forwarded** to the turn middleware (CLI passes `cfg?.retrieval?.metadataWeight`; WebUI falls back to 0.3). Same "silently ignored config" class.
3. **Shutdown hygiene passes only `retentionDays` + `archiveLowConfidenceAfterDays`** (start-webui.ts:1054-1057) vs the CLI's full surface (`sessionRetentionDays`, `archiveUnusedAfterDays`, `unusedMinInjections`, `purgeDeletedAfterDays`, `verify`). WebUI sessions get a weaker hygiene sweep.
4. **No auto-hygiene throttle** in the WebUI shutdown path (CLI enforces `AUTO_HYGIENE_INTERVAL_MS = 1 h`); every WebUI-server restart runs a full O(N) sweep.
5. `flushPendingCounters` is not called on the WebUI path — a documented no-op today (SQLite counters write synchronously), so this is latent only.

**Recommendation:** align the two wiring sites (extract one shared `setupSageMiddleware(pipelines, memoryStore, config, events, getSessionId)` used by both CLI and WebUI), forward `relationFloor`/`metadataWeight`, expand the WebUI shutdown hygiene options to the full config surface, and apply the same 1-hour throttle.

### 3.2 Complementary memory-hygiene layers (anchor verification)

Two layers exist and are deliberately split:

- **Periodic hygiene anchor check** (`sqlite-store-hygiene.ts:104-175`): **existence-only** (`fs.access`, 32 parallel workers) → marks `stale`/refreshes `verified` + `freshness:1`. Cheap O(N) sweep; **does not detect content changes** (file edited, symbol moved, command vanished — only a *gone* file stales).
- **On-demand deep verify** (`sqlite-store-verify.ts` → `anchors/verify.ts`): content hash, symbol presence, command resolution (with wrapper/flag awareness), batched git blob hashes → `verified`/`stale`. Invoked via `/memory verify` and `verifyOnMutation` on `write`/`edit`/`patch` (when `Sage.hygiene.autoOnFileChange !== false`).

**Gaps:** (a) no *scheduled* deep verification — a memory anchored to a file that changed (but wasn't deleted) stays `active` indefinitely unless a mutation verify or manual verify happens to hit it; (b) hygiene's `verify` option and deep verify are separate code paths with different semantics (existence vs content), which can disagree; (c) `verifyOnMutation` only covers the 3 mutation triggers, not reads of a changed file.

**Recommendations:** make deep-verify depth configurable for hygiene (`Sage.hygiene.verifyDepth: 'existence' | 'content' | 'git'`), run a scheduled deep pass (e.g., daily or on `git checkout`/branch switch), and report anchor-verification disagreement counts in the hygiene report.

### 3.3 `memory-triage-daily-dry-run` cron

**Verified finding: no code-level registration of this cron exists.** `grep` for the exact name across `packages/` returns nothing. The cron plugin (`packages/plugins/src/cron/index.ts`) is a runtime tool: jobs are scheduled on demand via `cron_schedule` (name + intervalMs + action string), listed via `cron_list`, and emitted as `cron:job_fired` events. So `memory-triage-daily-dry-run` is an **operator/agent-scheduled job** (typically action `/memory triage --dry-run`), not a built-in.

The triage machinery itself is real: `/memory triage` (`packages/cli/src/slash-commands/memory-triage.ts`) runs the 5-phase pipeline (preFilter → valueScore → LLM triage → merge detect → dispatch); **`--dry-run` is the default**; `--apply` auto-applies status/confidence updates, marks merges via `supersedes`, and files proposals as `MemoryCandidate`s via `Sage.createCandidate` (2026-08-04 — `memory_review` kind, `targetMemoryId`, `suggestedAction`), reviewable via `/memory candidates` and the WebUI MemoryManager.

**Gaps:** (a) nothing guarantees a daily dry-run happens — no default schedule, no persisted job config, no missed-run notification; (b) LLM phases 3/4 need a live provider, so a headless cron must have a configured provider at fire time (the slash command reads `opts.llmProvider`); (c) **overlap with hygiene candidates** — hygiene already emits `memory_review` candidates for unused/low-confidence/contradicted memories, while triage files its own proposals; the two pipelines can double-propose the same memory; (d) triage runs only over the host's live session context (slash command), so a WebUI-only deployment never triggers it.

**Recommendations:** add a config-driven default job (e.g., `Sage.triage.dailyDryRun: true` + fixed time) registered through the cron plugin at boot in both CLI and WebUI-server; dedupe with hygiene candidates (skip triage proposals for memories that already carry a pending `targetMemoryId` candidate); persist a `lastTriageReport` in the store or audit log for the WebUI to display.

---

## 4. WebUI memory display improvements

Current surface: `MemoryManager` — paginated virtualized list, Active/Deleted tabs, metric cards (total/active/needs-review/edges), filters (text, status, kind, tag chips, audience-only), detail panel with relationship graph (`graphFor`, maxDepth 1–3), full editor (kind/scope/tags/anchors/audience/supersedes/contradicts), file drawer, plus `ContextMemoryMonitor`/`MemoryLifecycleTrace`/`MemoryInjectorPanel`/`AudienceMemoryPanel` on the ContextDashboard, shelled by `SageTabs`. **Proposals (in increasing order of effort):**

1. **Grouping views** — "group by" switcher (kind / scope / anchor-file / status / persistence / audience): sectioned lists with counts and per-group collapse. Anchor-file grouping is the cheapest way to make the store readable as a map of the codebase. The backend already returns `statusCounts`; add `byKind`/`byScope`/`byAnchorDir` aggregates to the `listPage` response so grouping works across pages, not just the loaded page.
2. **Richer filtering** — anchor-type filter, persistence filter, audience-role filter, date-range (created/updated/lastUsed), "has pending review" filter, saved filter presets; move text search to the backend `query` param of `listSagePage` (client-side substring filter today) so search covers the whole store.
3. **Relationship visualization** — a dedicated graph tab: nodes = memories + their anchors (files/symbols), edges colored by relation type (`about_*`, `supersedes`, `contradicts`, `related_to`), filter by relation and by node kind; make depth configurable in the UI (backend clamps 1–3); "related cluster" per memory using `findRelatedSage`.
4. **Timeline view** — render by `createdAt`/`updatedAt`/`lastAccessedAt`; show lifecycle events (created → injected N times → used → stale → superseded/deleted → recovered) from the audit log (`readAudit`); an activity heatmap (injections/uses per day) makes unused-noise visible at a glance.
5. **Label/cluster views** — tag cloud with counts (exists in filters; promote to a cluster panel with co-occurrence links), kind clusters, audience clusters (by role/task/mode — pairs with `AudienceMemoryPanel`), auto-clusters from hygiene near-dup groups ("N near-duplicates collapsed into keeper").
6. **Review queue view** — a dedicated "Review" tab listing `memory_review` candidates with suggested action badges and bulk accept/reject/keep (today it is drawer-only and list-driven via `MemoryDrawer`); wire it to `memory.sage.candidateResolve`.
7. **Backend support** — one aggregation endpoint (`Sage.stats()` extended with byScope/byPersistence/byAudienceRole/injection-totals) so the dashboard does not depend on the loaded page.

---

## 5. Display of file-linked memories in file-manager pages

### Current state (verified)

- `MemoryDrawer` (`packages/webui/src/components/MemoryManager/MemoryDrawer.tsx`) is the rich file-linked surface: three buckets (cursor-boosted `symbolMatches`, `primaryMatches`, `relatedMatches`), `matchedVia` + `matchStrength` chips, cursor line-range boost (`lineStart`/`lineEnd`), Show-Recoverable toggle (deleted memories → one-click recover), and the ReviewQueue triple action (Accept Deletion / Keep / Update / Mark Permanent). Data via `useMemoryForFile` → `memory.sage.forFile` → `findMemoriesForFile` (server + store support complete).
- **However, it is reachable only from inside the MemoryManager** through a file-select dropdown (`MemoryManager/index.tsx:893-946`); `currentFilePath` is local state with no external setter found. The actual file editor (`CodeEditor.tsx`) renders `FileActivityDrawer` (overview/changes/context/logs tabs) with **no memory tab**, so file-linked memories are effectively invisible while editing a file.
- The dropdown is exactly the Safari case: `MemoryManager/index.tsx:916-921` renders `<option value={anchor.path} title={anchor.path}>{anchor.path}</option>` — long paths truncate visually, and **Safari does not render `<option title>` tooltips**, so the full path is unreachable there.

### Recommendations

1. **Wire the drawer into the file editor/explorer**: add a "Memory" tab to `FileActivityDrawer` (or a drawer toggle button when the active file has matches), storing `currentFilePath` in a shared UI store so the MemoryManager drawer can be opened from the editor. The cursor range (`lineStart`/`lineEnd`) is already supported by the backend — pass the editor cursor to get symbol-anchor boosting.
2. **Replace the `<option title>` selector** (Safari limitation) with one of:
   - **Custom tooltip**: a combobox component that shows a styled tooltip (hover/focus) with the full path next to the control — a plain `<option title>` is dead on Safari desktop and iOS.
   - **`<datalist>` + free-text input**: `<input list="memory-file-paths">` + `<datalist>` of anchor paths. Free-text entry lets users type a partial path (matching the "file manager" mental model) and Safari renders datalist suggestions natively; also solves truncation because the value is the editable full path. Keep an `aria-label` and a visible helper ("pick a file with memories").
   - For both: ensure ≥44px hit targets, `focus-visible` rings, and no reliance on hover-only affordances (WCAG 2.2 AA).
3. **File-explorer affordance**: show a small memory badge/count per file in `FileExplorer` (from `findMemoriesForFile` totals, fetched lazily) so users can discover that a file has knowledge attached before opening it.
4. Keep the read-only contract (opening a file never mutates the store) and the `MemoryForFileMatch` shape (the *why* — `matchedVia` — before actions).

---

## 6. Preserved constraints

1. **TUI and WebUI never construct a SAGE memory store.** The TUI receives `memoryStore` as a prop (`app-props.ts:692`); the WebUI consumes backend WS data only. Neither opens SQLite, spawns the daemon, or holds a writable port.
2. **All new SAGE access points must go through the runtime container's IPC binding.** Verified pipeline for adding a capability/op:
   - `packages/sage/src/project-server-protocol.ts` — declare the op type;
   - `packages/sage/src/project-server.ts` — dispatch case in `dispatch()`;
   - `packages/sage/src/remote-memory-port.ts` + `memory-port.ts` — mirror the method on both ports' capability literals (all three capability shapes: service/retrieval/surface);
   - `packages/sage/src/service-contract.ts` — update `SageServiceLike`/`SageSurface` (watch `exactOptionalPropertyTypes` — optional members must be `| undefined` in declarations AND capability literals);
   - `packages/core/src/types` — only if the capability crosses the core `MemoryPort`/`MemoryStore` boundary;
   - WebUI: `memory-handlers.ts` handler + `ws-client-actions.ts`/`useWebSocket.ts` + client types; TUI: slash command via the existing `memoryStore` prop.
3. **Single-writer invariant stays intact**: the daemon remains the sole SQLite owner; hosts hold IPC ports. Inline mode is test/offline-only and never a silent production fallback.
4. **Write-class SAGE tools stay `permission:'confirm'`; read-class stay `auto`** — the permission axis is load-bearing for any new MCP/CLI adapter.

---

## Assumptions / unverified

- `memory-triage-daily-dry-run` is assumed to be an operator-scheduled cron job (the exact name does not exist in the codebase; the cron plugin schedules jobs at runtime). If it exists in a deployment, it is a runtime artifact, not a code constant.
- `Sage.inject.toolResults` default `true` and `turnContext` default `false` are taken from the config schema docs (`mcp-features.ts:208-263`).
- No runtime test of the WebUI server was executed this session; all wiring claims are source-verified only.
