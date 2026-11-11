# Next-Generation Session Branching, Live TypeScript Plugins, and Synchronized TUI Graphics

- **Status:** Implemented (2026-11-11)
- **Scope:** `@wrongstack/contracts`, `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/plugin-sdk`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/cli`, `@wrongstack/webui`, `@wrongstack/project-surfaces`
- **Governing Contracts:** [Architecture](../architecture.md), [Plugin Author Guide](../plugin-author-guide.md), [Session Management](../slash/session.md), [Rewind](../slash/rewind.md)

---

## 1. Executive Summary

This document specifies the architecture, wire contracts, security boundaries, phased rollout, and verification gates for three foundational upgrades to WrongStack:

1. **CAS-Backed Session Tree (`/tree`) & Branch Fold-Back Summarization:** Evolves WrongStack's append-only JSONL session journal from linear-with-destructive-rewind into a non-destructive, intra-session directed acyclic graph (DAG) coupled to content-addressable workspace checkpoints (`checkpointCas`). Operators and autonomous loops can branch at any historical turn, test competing hypotheses against isolated workspace states, and fold distilled empirical findings from an exploratory branch back into a target branch as a single bounded context message—without polluting the main context window or losing abandoned transcripts.
2. **Zero-Build Native TypeScript Plugins, Atomic `/plugin reload`, & Declarative UI Slots:** Enables frictionless authoring of single-file and directory-based `.ts`/`.mts` external plugins loaded natively by Bun (and modern Node.js type-stripping) with zero manual build step, backed by deterministic Merkle closure TOFU pinning (`plugin-trust.json`). Replaces session restarts with an atomic, turn-quiesced hot-reload supervisor (`/plugin reload`) and introduces a host-neutral declarative UI extension contract (`api.ui`) that renders safely across both the Ink TUI and WebUI/Desktop v2.
3. **Synchronized TUI Frame Transport (`DECSET 2026`) & Terminal Inline Graphics:** Eliminates viewport tearing during high-throughput streaming, `/clear`, and terminal resize events via microtask-coalesced Begin/End Synchronized Update (`BSU`/`ESU`) framing, and introduces a cell-reserved terminal inline graphics pipeline (Kitty Graphics Protocol + iTerm2 `OSC 1337` with ANSI half-block/card fallbacks) so visual artifacts from `browser_screenshot`, `image_generate`, and `present_artifact` render directly inside the TUI without compromising `sanitizeTerminalText` security invariants or Ink layout stability.

All three initiatives adhere strictly to WrongStack's four architectural contracts:
- **Minimal kernel:** New behavior composes over `Container`, `Pipeline`, `EventBus`, and `RunController` without adding third-party daemon dependencies.
- **Zero non-overridable behavior:** Compaction, branch fold-back synthesis, plugin hot-swap hooks, and UI slot renderers register through typed registries.
- **Standalone sufficiency:** Every capability ships inside the single self-contained `wstack` binary with zero external tool requirements.
- **Security-first defaults:** Pre-import TOFU integrity verification, untrusted escape sequence sanitization, and project-root containment remain strictly enforced.

---

## 2. Initiative I — Content-Addressable Session Tree (`/tree`) & Branch Fold-Back

### 2.1 Baseline & Problem Statement

WrongStack already possesses strong primitives in [`packages/core/src/storage/session-store.ts`](../../packages/core/src/storage/session-store.ts):
- **Workspace Checkpoints (`checkpointCas`):** Before mutating turns, WrongStack captures `WorkspaceCheckpointRef` manifests (`git-head-plus-dirty`, `jj-head-plus-dirty`, `hg-head-plus-dirty`) and can restore disk state via `materializeCheckpoint`.
- **Destructive Rewind (`/rewind`):** [`packages/tui/src/components/checkpoint-timeline.tsx`](../../packages/tui/src/components/checkpoint-timeline.tsx) restores a selected checkpoint and **truncates** conversation history after that point.
- **Cross-File Forking (`forkSession`):** [`packages/core/src/storage/session-store/fork-session.ts`](../../packages/core/src/storage/session-store/fork-session.ts) copies the raw event prefix into a brand-new child `.jsonl` session file (`workspace: 'shared-current'`).

**Current Limitations:**
1. **Context Loss vs. Session Sprawl:** If an operator or `/goal` loop tries Approach A for 15 turns, hits a dead end, and rewinds to Turn 4, the transcript and negative lessons of Approach A are discarded from the active session. If they use `forkSession` instead, sessions multiply across separate IDs in `_index.jsonl` with no unified timeline and no mechanism to bring a concise summary of Approach A's failure back into Approach B.
2. **Shared-Workspace Drift on Forks:** `forkSession` sets `workspace: 'shared-current'` without tracking per-branch head workspace manifests, making switching back and forth between two active solution paths error-prone when uncommitted file edits exist.

### 2.2 Journal Data Model & Contract Extensions (`@wrongstack/contracts`)

Instead of splitting branches across separate `.jsonl` files, a single session `.jsonl` remains strictly append-only while modeling a tree of branches via lightweight attribution and control events.

#### 2.2.1 Attribution Extensions (`packages/contracts/src/types/session-events.ts`)

Extend `SessionEventAttribution` (stamped at the writer boundary, preserving backward compatibility with legacy journals where absence implies the root `"main"` branch):

```ts
export interface SessionEventAttribution {
  /** Subagent that produced this event; absent = the session's leader. */
  agentId?: string | undefined;
  /**
   * Monotonic 1-based sequence number assigned by the session writer.
   * Present on new journals; derived from line index when reading legacy journals.
   */
  seq?: number | undefined;
  /**
   * Branch identifier owning this event (`"main"` by default).
   * Absent on pre-tree journals, which implicitly belong to `"main"`.
   */
  branchId?: string | undefined;
}
```

#### 2.2.2 New Core Reconstruct Events

Add four variants to `SessionEventVariant` in [`packages/contracts/src/types/session-events.ts`](../../packages/contracts/src/types/session-events.ts) (all part of the **Core Reconstruct Set**, persisted regardless of `session.auditLevel`):

```ts
export interface SessionBranchDescriptor {
  branchId: string;              // 'main' | `br_${ULID}`
  name: string;                  // e.g. 'main', 'try-redis-lock', 'approach-b'
  parentBranchId: string | null; // null only for 'main'
  forkSeq: number;               // Exact parent event `seq` where this branch diverged
  forkPromptIndex?: number | undefined;
  createdAt: string;
  status: 'active' | 'folded' | 'archived';
  headWorkspaceCheckpoint?: WorkspaceCheckpointRef | undefined;
}

// Added to SessionEventVariant:
| {
    type: 'branch_created';
    ts: string;
    branchId: string;
    name: string;
    parentBranchId: string;
    forkSeq: number;
    forkPromptIndex?: number | undefined;
    baseWorkspaceCheckpoint?: WorkspaceCheckpointRef | undefined;
  }
| {
    type: 'branch_switched';
    ts: string;
    fromBranchId: string;
    toBranchId: string;
    /** Snapshot captured automatically on `fromBranchId` before switching away. */
    departureCheckpoint?: WorkspaceCheckpointRef | undefined;
    /** Workspace action taken when arriving on `toBranchId`. */
    workspaceMode: 'materialized' | 'kept-working-tree';
    materializedCheckpointHash?: string | undefined;
  }
| {
    type: 'branch_folded';
    ts: string;
    sourceBranchId: string;
    targetBranchId: string;
    sourceHeadSeq: number;
    outcome: 'insight-merged' | 'hypothesis-rejected' | 'partial-progress';
    /** Scrubbed synthetic message appended into `targetBranchId` context. */
    summaryMessage: Message;
    /** Optional SAGE observation IDs persisted from negative/positive findings. */
    sageMemoryIds?: string[] | undefined;
    archiveSource: boolean;
  }
| {
    type: 'branch_status_changed';
    ts: string;
    branchId: string;
    name?: string | undefined;
    status?: 'active' | 'folded' | 'archived' | undefined;
  }
```

#### 2.2.3 Summary & Metadata Projections (`packages/contracts/src/types/session.ts`)

Extend `SessionData` and `SessionSummary` in [`packages/contracts/src/types/session.ts`](../../packages/contracts/src/types/session.ts):
- `SessionSummary.branchCount?: number` and `SessionSummary.activeBranchName?: string` so `/sessions`, TUI ResumePicker, and WebUI session cards display branch indicators (e.g., `⎇ 3 branches · active: approach-b`).
- `SessionData.tree?: SessionTreeSnapshot` containing `activeBranchId`, `branches: Record<string, SessionBranchNode>`, and per-branch token/turn/checkpoint counts.

### 2.3 Deterministic Tree Replay & CAS Garbage-Collection Safety (`@wrongstack/core`)

#### 2.3.1 Single-Pass Ancestor Projection (`packages/core/src/storage/session-store/tree-replay.ts`)

Replaying a tree-structured journal must remain $O(N)$ in total journal lines and preserve heap bounds on superseded snapshots:

1. **Pass 1 (Topology Scan):** Scan event headers to build the branch table (`main` + each `branch_created`), determine `activeBranchId` (last `branch_switched` or `branch_created` if switched immediately, defaulting to `'main'`), and compute the **active lineage segments**:
   $$\text{Lineage}(B_k) = [(B_0, 0..\text{forkSeq}_1), (B_1, \text{forkSeq}_1+1..\text{forkSeq}_2), \dots, (B_k, \text{forkSeq}_k+1..\infty)]$$
2. **Pass 2 (Scoped Message Reconstruction):** Feed only events matching $(e.\text{branchId}, e.\text{seq}) \in \text{Lineage}(B_{\text{active}})$ into the existing `replayableMessage` / `applyContextSnapshot` state machine ([`packages/core/src/storage/session-store/replay.ts`](../../packages/core/src/storage/session-store/replay.ts)).
   - **Critical Invariant:** A `context_snapshot` or `messages_replaced` written by compaction on Branch B only replaces messages along Branch B's lineage; it never clobbers sibling Branch A's history.
   - **Heap Bound Preservation:** Superseded `context_snapshot` payloads *within the same branch segment* continue to be stripped in memory during `load()`, while raw disk reads (`readRawEvents`) keep full fidelity for future branches forked above a compaction point.

#### 2.3.2 Workspace Synchronization & Dirty-Tree Protection

Switching branches in a coding agent is dangerous if uncommitted edits silently leak or vanish. `SessionTreeCoordinator` enforces a three-step atomic switch protocol:

1. **Departure Capture:** Before leaving `fromBranchId`, call `captureCheckpoint` against the checkout root and record `departureCheckpoint` on `branch_switched`. Even if the user made manual edits outside WrongStack tools since the last prompt, the departing branch's exact working tree is safely stored in `checkpointCas`.
2. **Arrival Materialization Policy:**
   - `--workspace restore` (default when `toBranchId` has a recorded `headWorkspaceCheckpoint` or `baseWorkspaceCheckpoint`): Materialize the target branch's latest CAS manifest via `materializeCheckpoint`, re-run `ResumeValidation` stale-file checks, and notify the active LSP/Codebase Index watcher of changed paths.
   - `--workspace keep`: Switch only the conversation branch cursor while keeping the current disk files untouched (useful when comparing two planning/review branches over the same code).
3. **CAS Reachability Update:** Update `collectReachableManifestHashes` in `packages/core/src/storage/session-checkpoint-gc.ts` so `sweepCheckpointCas` retains manifests referenced by:
   - `checkpoint` / `workspace_checkpoint` events on any non-archived branch,
   - `branch_created.baseWorkspaceCheckpoint`, and
   - `branch_switched.departureCheckpoint` for the latest state of every active/folded branch.

### 2.4 Branch Fold-Back Summarization Engine

The defining workflow upgrade is **folding an exploratory branch back into its parent (or any target branch)**.

#### 2.4.1 Execution Flow (`/tree fold [source] [--into <target>] [--note "..."]`)

```text
  [main] ──● Turn 1 ──● Turn 2 (forkSeq=18, CAS#a1f) ──● [branch_folded summary] ──▶ Turn 3 (clean context!)
                         │                                      ▲
                         └── [try-wasm-parser]                  │
                              ├── Turn 3a: edit parser.ts       │ One-Shot Fold Synthesizer
                              ├── Turn 4a: bun run test (FAIL)  │ (SecretScrubber + Token Cap)
                              └── Turn 5a: memory spike found ──┘
```

1. **Delta Extraction:** Slice events exclusive to `sourceBranchId` (`seq > forkSeq` up to `sourceHeadSeq`), plus tool execution summaries (`tool_call_end`, file diffs from `departureCheckpoint` vs. `baseWorkspaceCheckpoint`, and test/lint exit codes).
2. **Structured Synthesis via One-Shot Orchestrator:** Route through WrongStack's shared One-Shot completion service (`role: 'compaction'`, respecting model-matrix fallbacks) using a deterministic structured system prompt that produces a compact Markdown digest (hard-capped at `1,200` tokens by default, configurable via `session.branchFoldMaxTokens`):
   - **Goal / Hypothesis:** What `sourceBranchId` attempted.
   - **Changes & Experiments:** Files touched, commands/tests executed, key metrics.
   - **Verified Outcome:** Why the branch succeeded, partially worked, or was rejected (exact error signatures / architectural blockers).
   - **Carry-Forward Constraints:** Actionable guidance for `targetBranchId` (e.g., *"Do not use synchronous `fs.cpSync` in worker setup; Windows file locks fail under Vitest pool concurrency"*).
3. **Scrubbing & Injection:** Pass the synthesized block through `SecretScrubber`, wrap it in a typed `<branch_fold_summary branch="..." outcome="...">` user/system context block, switch to `targetBranchId` (materializing `targetBranchId`'s clean CAS workspace if not already active), and append the `branch_folded` event.
4. **Optional SAGE Promotion:** When `features.sageBranchInsights !== false` and the fold outcome is `hypothesis-rejected` or `insight-merged`, offer (or queue via SAGE Memory Companion) code-anchored negative/positive constraints anchored to the investigated file paths so future sessions also avoid the dead end.

### 2.5 Surface Integration (`/tree`)

| Surface | Interaction Model |
|---|---|
| **CLI / REPL** | `/tree` prints an indented DAG with active marker `*`, turn counts, token totals, and CAS dirty badges. Subcommands: `/tree branch <name> [--at <checkpointIndex>]`, `/tree switch <name\|id> [--keep-files]`, `/tree fold [source] [--into <target>] [--keep-open]`, `/tree rename <id> <newName>`, `/tree archive <id>`. |
| **TUI (`--tui`)** | Mounts `SessionTreeOverlay` (`packages/tui/src/components/session-tree-overlay.tsx`), superseding and unifying `/rewind` (while keeping `/rewind` as a direct alias to the linear checkpoint view on the current branch). Keyboard shortcuts: `↑/↓` navigate turns/checkpoints, `←/→` jump across sibling branches, `b` create branch at cursor, `Enter` switch to selected branch/checkpoint, `f` fold selected branch into parent with preview modal, `d` view file diff summary against parent. |
| **WebUI / VibeUI / Desktop v2** | Shared `@wrongstack/project-surfaces` component adds a **Branch Selector Pill** in the chat header (`⎇ main ▾`) and upgrades **Session Story** (`docs/session-story.md`) to render multi-branch conversation forks alongside subagent lanes, with one-click **Branch from here** on any historical user/assistant turn card and **Fold insights into parent** on non-root branches. |
| **Autonomous `/goal` Loop** | Exposes an internal `session_branch` capability gated by the **Brain**: when `/goal` hits 2 consecutive verification regressions on a speculative refactor, the Brain can advise folding the failed attempt back to the last passing checkpoint rather than spiraling deeper on broken edits. |

---

## 3. Initiative II — Zero-Build TypeScript Plugins, Live `/plugin reload`, & Declarative UI Slots

### 3.1 Baseline & Problem Statement

WrongStack's plugin architecture ([`packages/core/src/plugin/loader.ts`](../../packages/core/src/plugin/loader.ts), [`packages/runtime/src/plugin-host/external-plugins.ts`](../../packages/runtime/src/plugin-host/external-plugins.ts)) already implements two critical foundations that most tools lack:
- **Scoped Registration Ownership (`drainCleanup`):** Registrations made via `api.tools`, `api.providers`, `api.slashCommands`, `api.extensions`, `api.registerSystemPromptContributor`, and `api.onEvent` are tracked per-plugin lifetime and drained cleanly on disposal—even recomposing nested tool wrappers (`api.tools.wrap`) when an inner plugin unloads.
- **Pre-Import TOFU Integrity Pinning (`plugin-trust.json`):** [`packages/core/src/plugin/trust.ts`](../../packages/core/src/plugin/trust.ts) hashes external plugin entries with SHA-256 before executing a single line of code.

**Current Friction Points:**
1. **Build-Step Requirement:** [`packages/core/src/plugin/discovery.ts`](../../packages/core/src/plugin/discovery.ts) restricts `ENTRY_EXTENSIONS` to `['.js', '.mjs', '.cjs']`. Dropping `~/.wrongstack/plugins/custom-gate.ts` into the global plugins folder is ignored unless the author sets up `tsconfig.json` and compiles to JS first.
2. **Cold-Restart Penalty:** [`packages/runtime/src/portable-commands/plugin.ts`](../../packages/runtime/src/portable-commands/plugin.ts) outputs `Restart WrongStack to load or unload plugin code in this session.` Iterating on a custom tool, slash command, or compaction hook forces quitting the active session, losing live TUI state and warm caches.
3. **No Safe UI Surface for Plugins:** External plugins can register tools, middleware, and text-only slash commands, but have zero way to render live status telemetry, custom inspection drawers, or interactive pickers in the TUI/WebUI.

### 3.2 Zero-Build Native TypeScript Discovery & Loading

#### 3.2.1 Discovery Precedence (`packages/core/src/plugin/discovery.ts`)

Update `ENTRY_EXTENSIONS` to support TypeScript sources natively while keeping compiled artifacts authoritative when a published package ships `dist/`:

```ts
export const ENTRY_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.cjs'] as const;
export const DIRECTORY_INDEX_FALLBACKS = [
  'index.ts',
  'index.mts',
  'index.js',
  'index.mjs',
  'index.cjs',
] as const;
```

Resolution order for `<root>/<plugin-name>/`:
1. `package.json` `exports["."]` (`import` → `module` → `default`) or `main` (resolving exact path or extension fallbacks).
2. `DIRECTORY_INDEX_FALLBACKS` (`index.ts` preferred over stale `index.js` when no `package.json` exists; if *both* `index.ts` and `index.js` exist without `package.json`, emit a single `api.log.warn` naming the chosen `index.ts` entry).
3. Single-file plugins directly under `<root>/`: `<plugin-name>.ts` / `.mts` / `.js` / `.mjs` / `.cjs`.
4. Ignore `.d.ts`, `.test.ts`, `.spec.ts`, dot-files, and `node_modules/`.

Project-local plugins (`<projectRoot>/.wrongstack/plugins/`) **remain inactive by default** until explicitly enabled in user/project config and verified by TOFU, preventing untrusted cloned repositories from auto-executing `.ts` files.

#### 3.2.2 Runtime Module Loader & Cache-Busting (`packages/runtime/src/plugin-host/ts-module-loader.ts`)

WrongStack executes primarily on **Bun ≥ 1.4.3** (both in source checkouts and inside the standalone `wstack` compiled binary), while maintaining Node.js (`^22.22.2 || ^24.15.0 || >=26.0.0`) compatibility:

1. **Bun & Standalone Binary Path (Zero Overhead):**
   - Bun's native module loader transpiles `.ts` and `.mts` in C++/Zig at sub-millisecond speed with full `tsconfig` path/decorator tolerance and `@wrongstack/plugin-sdk` virtual specifier resolution.
   - Inside the standalone `wstack` binary, register a lightweight `Bun.plugin` virtual resolver for `@wrongstack/plugin-sdk` and `@wrongstack/contracts` type/helper runtime exports (`definePlugin`, schema helpers) so standalone single-file `.ts` plugins in `~/.wrongstack/plugins/` can write `import { definePlugin } from '@wrongstack/plugin-sdk'` **without running `bun install`**.
2. **Node.js Compatibility Path:**
   - Node 22.22+ / 24.15+ / 26+ supports native `.ts` type-stripping on `import()`. If a plugin uses non-erasable TypeScript syntax (`enum`, `namespace`, parameter properties) under Node, catch `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` and fall back to stripping/transpiling into an ephemeral memory `data:text/javascript;base64,...` module with inline `# sourceURL=` source maps so stack traces still report exact `.ts` line numbers.
3. **Reload Cache Invalidation & Module Graph Hygiene:**
   - Standard `import(fileUrl)` caches ESM modules permanently per URL in both V8 and JavaScriptCore (`Loader.registry`).
   - On initial load (`gen = 0`), import `file:///.../my-plugin.ts`.
   - On reload (`gen = 1, 2, ...`), resolve the plugin's local relative import closure (`.ts`/`.js` files inside the plugin directory):
     - Under Bun: evict the plugin's resolved module URLs from `Loader.registry` prior to re-importing `file:///.../my-plugin.ts?wstack_reload=<gen>`, preventing unbounded ESM module cache growth across dozens of reloads and ensuring relative helper files (`./helper.ts`) also reload!
     - Under Node: rewrite local relative imports inside the plugin closure with `?wstack_reload=<gen>` via a lightweight loader hook or ephemeral bundle pass, bounded to max 64 local files.

#### 3.2.3 Closure-Aware Merkle TOFU Pinning (`packages/core/src/plugin/trust.ts`)

Single-file `hashFileContents(entryPath)` only hashes the entry file. With zero-build `.ts` directory plugins (`my-plugin/index.ts` importing `./rules.ts`), modifying `rules.ts` must not bypass TOFU tamper detection!

Extend `hashPluginIntegrity(candidate)` in [`packages/core/src/plugin/trust.ts`](../../packages/core/src/plugin/trust.ts):
- **Single-file plugin (`foo.ts`):** SHA-256 of the file bytes (100% backward-compatible digest format with existing `plugin-trust.json` entries).
- **Directory plugin (`foo/index.ts`):** Compute a deterministic **Merkle manifest SHA-256** over all source/manifest files in `foo/` (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`, excluding `node_modules/`, `.git/`, and build caches; hard-capped at 256 files / 8 MiB):
  $$\text{Digest} = \text{SHA256}\Big(\sum_{i=1}^{k} \text{posixRelPath}_i \mathbin{\|} \text{'\textbackslash0'} \mathbin{\|} \text{SHA256}(\text{bytes}_i) \mathbin{\|} \text{'\textbackslash n'}\Big)$$
- **Authoring Ergonomics on Trust Mismatch:** When a developer edits their own `~/.wrongstack/plugins/foo.ts` and runs `/plugin reload foo`, if `verifyPluginTrust` returns `{ status: 'changed' }`:
  - Interactive TUI / WebUI / REPL surfaces prompt immediately: *"Plugin `foo` source changed (`a18c…` → `94e2…`). Re-pin trust and reload? [y/N/diff]"* (where `diff` shows line count & changed files).
  - Non-interactive / headless surfaces fail closed with instructions to run `wstack plugin trust foo`.
  - Optional developer flag: `/plugin watch <name>` (restricted strictly to user-global `~/.wrongstack/plugins/<name>` during the current interactive TTY session; never persisted to config and never allowed for `<projectRoot>/.wrongstack/plugins/`).

### 3.3 Atomic `/plugin reload` Supervisor (`@wrongstack/core` & `@wrongstack/runtime`)

Replace the boot-only plugin array with `PluginRuntimeSupervisor` wrapping `PluginHostHandle` ([`packages/core/src/plugin/loader.ts`](../../packages/core/src/plugin/loader.ts)).

#### 3.3.1 Four-Phase Hot-Swap Transaction

When `/plugin reload [name|*]` (or `ConfigStore` enable/disable toggle) runs:

```text
  Phase 1: Quiesce        Phase 2: Stage & Validate     Phase 3: Drain Old        Phase 4: Commit & Broadcast
 ┌──────────────────┐    ┌─────────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
 │ Check in-flight  │───▶│ Hash closure (TOFU)     │──▶│ old.teardown(10s)    │──▶│ new.setup(newScopedApi)  │
 │ tool/turn calls  │    │ Import fresh TS module  │   │ drainCleanup()       │   │ Recompose tool wrappers  │
 │ owned by plugin  │    │ Validate shape & schema │   │ Close plugin MCP/UI  │   │ Emit `plugin.reloaded`   │
 └──────────────────┘    └───────────┬─────────────┘   └──────────────────────┘   └──────────────────────────┘
                                     │ (Syntax/Type/Trust Error)
                                     ▼
                         [ABORT: Old plugin remains untouched & live!]
```

1. **Phase 1 — Quiescence Gate:** Inspect `RunController` / `ToolExecutor` active call table. If a tool owned or wrapped by `name` is currently executing, await settlement up to `5,000 ms` (unless `--force` is passed, which aborts plugin-owned background tasks).
2. **Phase 2 — Pre-Swap Staging (Zero-Downtime Failure):** Resolve entry path, verify TOFU hash, import the new `.ts`/`.js` module, run `validateExternalPluginModule`, check `apiVersion` compatibility against `KERNEL_API_VERSION`, and validate `configSchema` **before touching the running plugin**. A TypeScript syntax error in the edited file reports exact file/line/column in the TUI/WebUI while leaving the previous version running cleanly.
3. **Phase 3 — Scoped Teardown & Drain:** Run `oldPlugin.teardown(oldApi)` under `teardownTimeoutMs` (10s), invoke `cleanupApi.drainCleanup()` (atomically unregistering tools, slash commands, providers, hooks, UI slots, and recomposing tool wrappers), and stop any MCP servers started via `oldApi.mcp`.
4. **Phase 4 — Setup, Rollback Safety, & Live Catalog Sync:** Invoke `newPlugin.setup(newApi)` under `setupTimeoutMs` (30s) with `wrapApiForCapabilityCheck`.
   - **Rollback on Setup Failure:** If `newPlugin.setup()` throws or violates declared `capabilities`, drain partial registrations from `newApi` immediately and re-setup `oldPlugin` so the session is never left half-wired.
   - **Surface Refresh:** Emit `plugin.reloaded` (`{ name, version, durationMs, addedTools, removedTools, slashCommands, uiSlots }`) on `EventBus`. TUI slash autocomplete, WebUI `/plugin` drawer, ACP `/` command advertisements, and `tool_search` indexes refresh live in `< 50 ms`—eliminating `RESTART_NOTE` from [`packages/runtime/src/portable-commands/plugin.ts`](../../packages/runtime/src/portable-commands/plugin.ts)!

### 3.4 Host-Neutral Declarative UI Slots (`api.ui`) & Custom Compaction Hooks

#### 3.4.1 Why Declarative View Primitives Instead of Raw React/Ink Exports

Allowing external `.ts` plugins to import `ink` / `react` directly and return JSX elements fails two WrongStack architectural invariants:
1. **Dual-React Crash in Standalone Binaries:** External modules resolving their own `react` copy collide with the bundled Ink reconciler (`Invalid hook call`).
2. **Five-Surface Parity:** A raw Ink component cannot render in **WebUI**, **VibeUI**, **WrongStack Desktop v2**, or **HQ**.

Instead, `PluginAPI` exposes `api.ui` (gated by `capabilities: { ui: true }` in `PluginManifest`, strictly enforced by `wrapApiForCapabilityCheck`):

#### 3.4.2 `PluginUiAPI` Contract (`@wrongstack/contracts/types/plugin.ts`)

```ts
export type UiTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export interface PluginStatusChipSpec {
  id: string;
  /** Short text (sanitized and truncated to <= 24 terminal columns). */
  text: string;
  icon?: string | undefined;
  tone?: UiTone | undefined;
  tooltip?: string | undefined;
  priority?: number | undefined; // default 0; bounded [-100, 100]
  /** Optional slash command or panel ID triggered on click / shortcut. */
  command?: string | undefined;
}

export type PluginViewNode =
  | { kind: 'text'; text: string; tone?: UiTone; dim?: boolean; bold?: boolean }
  | { kind: 'kv'; items: Array<{ label: string; value: string; tone?: UiTone }> }
  | { kind: 'table'; columns: string[]; rows: string[][]; maxRows?: number }
  | { kind: 'badges'; badges: Array<{ label: string; tone?: UiTone }> }
  | { kind: 'progress'; label: string; current: number; total: number; tone?: UiTone }
  | { kind: 'code'; language?: string; content: string; maxLines?: number }
  | { kind: 'markdown'; content: string }
  | { kind: 'log'; lines: Array<{ ts?: string; level?: UiTone; text: string }> }
  | { kind: 'stack'; direction: 'vertical' | 'horizontal'; gap?: number; children: PluginViewNode[] };

export interface PluginPanelSpec {
  id: string;
  title: string;
  render(): PluginViewNode | Promise<PluginViewNode>;
  actions?: Array<{
    id: string;
    label: string;
    shortcut?: string; // e.g. 'r' (scoped inside the open panel only; never hijacks global TUI keys)
    mutating?: boolean;
  }>;
  onAction?(actionId: string): void | Promise<void>;
}

export interface PluginUiAPI {
  /** Register a live status chip in the TUI StatusBar and WebUI/Desktop footer. */
  registerStatusChip(initial: PluginStatusChipSpec): {
    update(patch: Partial<Omit<PluginStatusChipSpec, 'id'>>): void;
    dispose(): void;
  };
  /** Register an inspectable panel accessible via `/panel <owner:id>`, TUI picker, and WebUI sidebar. */
  registerPanel(spec: PluginPanelSpec): {
    invalidate(): void;
    dispose(): void;
  };
  /** Show a bounded interactive prompt (falls back cleanly or rejects on headless non-TTY runs). */
  prompt<T extends string>(opts: {
    title: string;
    message?: string;
    kind: 'select' | 'confirm' | 'input';
    options?: Array<{ value: T; label: string; hint?: string }>;
    timeoutMs?: number; // default 60_000, hard-capped at 300_000
  }): Promise<T | boolean | string | null>;
  /** Push a transient non-blocking toast/notice to TUI notice rail & WebUI notification center. */
  notify(message: string, opts?: { tone?: UiTone }): void;
}
```

**Security & Performance Guardrails on `api.ui`:**
- Every string in `PluginStatusChipSpec`, `PluginViewNode`, and `notify` passes through `sanitizeTerminalText` ([`packages/core/src/utils/terminal-sanitize.ts`](../../packages/core/src/utils/terminal-sanitize.ts)) before reaching TUI or HTML renderers.
- Status chip updates are rate-limited (`4 Hz` trailing-edge throttle per plugin) so a chatty plugin loop cannot starve Ink's 30 FPS budget; total external status bar width is capped at 30% of `stdout.columns` with overflow collapsed into a `+N` indicator.
- `PluginViewNode` tree depth is capped at `8` levels and `64 KiB` serialized payload per render.
- All `api.ui` registrations are tied to the plugin's `drainCleanup()` lifecycle—unloading or hot-reloading a plugin immediately unmounts its chips and closes any open panel.

#### 3.4.3 Pluggable Compaction & Fold Customizers (`api.extensions.registerCompactionHook`)

Allow plugins to tailor how `/compact` and `/tree fold` preserve domain-critical state (e.g., preserving database schema invariants, active test failure matrices, or security audit ledgers):
- `beforeCompact(ctx)` can mark specific message indices as pinned, supply custom summary section instructions, or return a custom summary payload.
- Post-hook invariant enforcement stays owned by `@wrongstack/core`: even when a plugin supplies a custom compaction summary, Core unconditionally runs `SecretScrubber`, repairs orphaned `tool_use`/`tool_result` adjacency pairs, and enforces token ceilings.

---

## 4. Initiative III — Synchronized TUI Frame Pipeline (`DECSET 2026`) & Inline Terminal Graphics

### 4.1 Baseline & Problem Statement

[`packages/tui/src/run-tui-mount.ts`](../../packages/tui/src/run-tui-mount.ts) mounts Ink 8 at `30 FPS` (`15 FPS` frugal) with `incrementalRendering: true`, while [`packages/tui/src/run-tui.ts`](../../packages/tui/src/run-tui.ts) manages raw mode, alternate screen, bracketed paste, and `/clear` (`\x1b[2J\x1b[3J`).

**Current Gaps:**
1. **PTY Split-Read Tearing:** On POSIX PTYs, SSH sessions, `tmux`, and ConPTY, a large Ink update (or a `stdout.write('\x1b[J')` resize erase followed by Ink's re-render in [`packages/tui/src/run-tui-mount.ts`](../../packages/tui/src/run-tui-mount.ts)) can span multiple `write()` calls or exceed a single 4–16 KiB PTY kernel buffer read. When the terminal emulator renders between the erase sequence and the repainted lines, visible flicker/tearing occurs—especially during fast token streaming, panel transitions, and window resizing.
2. **Blind Visual Tooling in Terminal:** WrongStack ships rich visual tools (`browser_screenshot`, `image_generate`, `design`, `present_artifact`), yet `--tui` users only see a text path (`Saved screenshot to ...`), forcing context-switching to an external image viewer or browser UI.

### 4.2 Coalesced Synchronized Output Transport (`DECSET 2026`)

Modern terminal emulators (Kitty, Ghostty, WezTerm, Alacritty ≥ 0.12, foot, iTerm2, Rio, Contour, Windows Terminal ≥ 1.18, VS Code Terminal / xterm.js, and tmux ≥ 3.2) implement **Mode 2026 Synchronized Output**:
- `BSU` (`\x1b[?2026h`): Terminal buffers all subsequent screen mutations without painting to the display surface.
- `ESU` (`\x1b[?2026l`): Terminal atomically composites and presents the buffered frame on the next display refresh.
- Terminals that do not recognize private mode `?2026` silently ignore CSI `?2026h`/`?2026l` per ECMA-48 / DEC private mode rules.

#### 4.2.1 Capability Detection (`packages/core/src/utils/terminal-capability.ts`)

Extend `TerminalCapability` in [`packages/core/src/utils/terminal-capability.ts`](../../packages/core/src/utils/terminal-capability.ts) (computed once at startup, pure & zero-I/O):

```ts
export type TerminalGraphicsProtocol = 'kitty' | 'iterm2' | 'halfblock' | 'none';

export interface TerminalCapability {
  // ...existing fields (isRealTTY, colorDepth, stdoutWritable, mouseProtocol, canSetTitle, isTmux, isWindowsConhost)
  /**
   * True when stdout is a real non-dumb TTY and not legacy Windows conhost.
   * Respects `WRONGSTACK_TUI_SYNC=0` (force off) and `WRONGSTACK_TUI_SYNC=1` (force on).
   */
  supportsSyncOutput: boolean;
  /**
   * Best inline image rendering protocol supported by the attached emulator.
   * Respects `WRONGSTACK_TUI_GRAPHICS=auto|kitty|iterm2|halfblock|off`.
   */
  graphicsProtocol: TerminalGraphicsProtocol;
}
```

Detection matrix for `graphicsProtocol` (when `WRONGSTACK_TUI_GRAPHICS` is unset or `auto`):
1. `TERM=dumb`, `!isRealTTY`, `isWindowsConhost`, or `isFrugalPerf()` → `'none'`.
2. `KITTY_WINDOW_ID` set, `TERM=xterm-kitty`, `GHOSTTY_RESOURCES_DIR` set, `TERM=xterm-ghostty` → `'kitty'`.
3. `WEZTERM_PANE` set or `TERM_PROGRAM=WezTerm` → `'iterm2'` (or `'kitty'`; WezTerm supports both cleanly, `OSC 1337` requires single-sequence framing and works across SSH effortlessly).
4. `TERM_PROGRAM=iTerm.app`, `TERM_PROGRAM=WarpTerminal`, `TERM_PROGRAM=rio`, `LC_TERMINAL=iTerm2` → `'iterm2'`.
5. Inside `tmux` (`isTmux === true`): `'none'` by default unless `WRONGSTACK_TUI_TMUX_PASSTHROUGH=1` is set (because tmux drops `APC`/`OSC` passthrough sequences unless the user configured `set -g allow-passthrough on` in `tmux.conf`; defaulting to `'halfblock'` avoids silent blank boxes).
6. Any other `colorDepth === 3` (24-bit truecolor) terminal (e.g., Alacritty, foot, Windows Terminal, VS Code Terminal) → `'halfblock'` (crisp 2× vertical-resolution Unicode `▀`/`▄` truecolor preview with metadata header).
7. Otherwise → `'none'`.

#### 4.2.2 `SynchronizedWriteStream` (`packages/tui/src/sync-stdout.ts`)

Add `SYNC_OUTPUT_ON = '\x1b[?2026h'` and `SYNC_OUTPUT_OFF = '\x1b[?2026l'` to [`packages/tui/src/terminal-modes.ts`](../../packages/tui/src/terminal-modes.ts), and wrap the `stdout` passed to `mountInkApp` and `/clear`:

1. **Microtask Frame Coalescing:**
   - When Ink (or `onResize`'s `\x1b[J` followed immediately by Ink's resize re-render) invokes `syncStdout.write(chunk)` one or more times in the same synchronous turn, queue the chunks in a pre-allocated array and flush them at the end of the current microtask (`queueMicrotask`) wrapped in a single contiguous buffer:
     $$\text{WriteBuffer} = \texttt{\textbackslash x1b[?2026h} \mathbin{\|} \text{chunk}_1 \mathbin{\|} \dots \mathbin{\|} \text{chunk}_k \mathbin{\|} \texttt{\textbackslash x1b[?2026l}$$
   - Out-of-band window title `OSC 0/2` updates (`createRunTuiTitleController`) write either inside the coalesced batch or directly when idle without triggering empty BSU/ESU pairs.
   - **Buffer Cap:** If queued bytes within one microtask exceed `512 KiB` (e.g., dumping an enormous static transcript), flush immediately so a single synchronized frame never exceeds terminal emulator BSU buffer caps (commonly 1–4 MiB).
2. **Trace & Teardown Wiring:**
   - Layer order: `Ink` → `SynchronizedWriteStream` → `WRONGSTACK_TUI_TRACE` tee → real `process.stdout`, so `WRONGSTACK_TUI_TRACE=1` captures the exact `BSU`/`ESU` wire bytes for deterministic byte-level regression tests.
   - **Unconditional Cleanup Reset:** In [`packages/tui/src/run-tui-exits.ts`](../../packages/tui/src/run-tui-exits.ts), `cleanup()` flushes any pending microtask chunk and writes `SYNC_OUTPUT_OFF` (`\x1b[?2026l`) alongside `BRACKETED_PASTE_OFF` and `MOUSE_OFF` on **all six exit paths**, guaranteeing no terminal is ever left inside a synchronized update block on abort or crash.

### 4.3 Cell-Reserved Terminal Inline Graphics Engine (`packages/tui/src/graphics/`)

#### 4.3.1 Solving the Ink Layout & Reconciler Conflict

Writing raw Kitty (`\x1b_G...`) or iTerm2 (`\x1b]1337;...`) escape sequences inside an Ink `<Text>` component breaks standard Ink rendering for two reasons:
1. `string-width` / `wrap-ansi` may mismeasure or split multi-kilobyte control strings across soft-wrapped columns, corrupting the escape sequence.
2. Ink's live region uses cursor-relative `eraseLines` on every re-render; re-emitting multi-hundred-kilobyte base64 images at 30 FPS while streaming text below them causes massive bandwidth waste and cursor drift.

**Architectural Solution — Two Safe Surfaces Only:**
Inline graphics are rendered **exclusively** in two places where Ink never shifts row offsets mid-stream:
1. **Committed `<Static>` History Entries:** Completed tool cards (`browser_screenshot`, `image_generate`, `present_artifact` with `image/*`) live inside Ink's committed `<Static>` stream. Once committed to scrollback, Ink never erases or re-layouts them!
   - The component renders a header row (`🖼 screenshot-login.png · 1280×720 · 84 KB`), emits the single self-contained graphics escape sequence + `\n`.repeat(`reservedRows`) in one atomic Static commit chunk, so terminal scrollback advances by the exact `reservedRows` height of the image.
2. **Pinned Modal Lightbox (`ImagePreviewModal`):** Pressing `i` or clicking an image card opens a full-screen modal overlay while streaming is paused/masked. The image is drawn once at known `(row, col)` coordinates inside `<Box width={cols} height={rows}>` and cleared cleanly (`\x1b_Ga=d,d=i,i=<imageId>,q=2\x1b\\` on Kitty; screen erase on iTerm2) when `Esc` closes the modal.

#### 4.3.2 Zero-Dependency Image Header Parser & Wire Encoders

To preserve WrongStack's zero-native-addon standalone binary guarantee (no `sharp` or `canvas` native binaries!), `@wrongstack/tui` implements a pure TypeScript header & thumbnail pipeline (`packages/tui/src/graphics/image-codec.ts`):

1. **Magic-Byte & Dimension Inspector (`inspectImageBuffer`):**
   - Validates magic bytes and extracts exact pixel `width × height` in `< 0.1 ms` from raw bytes:
     - **PNG:** `\x89PNG\r\n\x1a\n` + `IHDR` chunk (`bytes 16..23` big-endian uint32).
     - **JPEG:** `\xff\xd8` + scan to `SOF0`/`SOF2` (`\xff\xc0`/`\xff\xc2`) frame header.
     - **GIF:** `GIF87a`/`GIF89a` logical screen descriptor (`bytes 6..9` little-endian uint16).
     - **WebP:** `RIFF....WEBP` (`VP8 `, `VP8L`, `VP8X` header dimensions).
   - Rejects SVG, HTML, polyglot files, corrupt headers, or files exceeding `maxInputBytes` (`4 MiB` default) **before** encoding.
2. **Aspect-Ratio Cell Reservation (`computeCellBox`):**
   - Given pixel `(w, h)`, terminal `stdout.columns`, max preview height (`default: 14 rows` inline, `75%` of `stdout.rows` in modal), and assumed cell aspect ratio (`1:2` width:height), computes exact integer `(cols, rows)` so the image never overflows horizontal viewport width.
3. **Protocol Encoders:**
   - **Kitty Graphics Protocol (`encodeKittyImage`):**
     - PNG payloads (`f=100`) transmitted in `4,096`-byte base64 chunks:
       - First chunk: `\x1b_Ga=T,f=100,i=<id>,c=<cols>,r=<rows>,C=1,q=2,m=1;<b64_chunk_0>\x1b\\`
       - Middle chunks: `\x1b_Gm=1;<b64_chunk_k>\x1b\\`
       - Final chunk: `\x1b_Gm=0;<b64_chunk_last>\x1b\\`
     - **`q=2` (Quiet Mode — Mandatory Security/UX Invariant):** Suppresses both `OK` and error APC replies from Kitty/Ghostty so the terminal emulator **never** injects `\x1b_Gi=...;OK\x1b\\` into `process.stdin` where Ink's raw input handler could misread bytes as user keystrokes!
     - **`C=1` (Do Not Move Cursor) + Explicit Newline Reservation:** Keeps cursor movement 100% deterministic across Kitty and Ghostty versions; WrongStack advances the exact `rows` count via `\r\n` lines inside the committed block.
   - **iTerm2 Inline Images Protocol (`encodeIterm2Image`):**
     - Single sequence: `\x1b]1337;File=name=<b64Name>;size=<byteLen>;width=<cols>;height=<rows>;preserveAspectRatio=1;inline=1:<base64Payload>\x07`.
   - **24-Bit Truecolor Half-Block Fallback (`encodeHalfBlockPreview`):**
     - For uncompressed/PNG screenshots on non-Kitty/iTerm2 truecolor terminals (using Node/Bun built-in `zlib.inflateSync` on PNG IDAT scanlines—zero external dependencies!), samples an `80 × 24` pixel grid into `12` terminal rows using `▀` (`\x1b[38;2;R1;G1;B1;48;2;R2;G2;B2m▀`), giving Windows Terminal and VS Code integrated terminal users instant visual layout feedback!

#### 4.3.3 Security & Heap Hardening

- **Untrusted Text Sanitization Remains Absolute:** [`packages/core/src/utils/terminal-sanitize.ts`](../../packages/core/src/utils/terminal-sanitize.ts) is **not** weakened. Any escape sequence emitted by an LLM response, MCP server text block, `bash` stdout, or plugin text string continues to be stripped unconditionally. Only `TrustedImageAttachment` objects produced by host-verified local file reads (inside allowed project/runtime paths after permission checks) reach `encodeKittyImage` / `encodeIterm2Image`.
- **Stdin Defense-in-Depth:** Even with `q=2`, `packages/tui` input preprocessing strips any `\x1b_G[\s\S]*?\x1b\\` APC frame arriving on `stdin` before dispatching to `useInput` or raw `Ctrl+C` watchers.
- **Heap Soak Discipline (`bench:tui-heap`):** Raw buffers are released immediately after encoding; at most `8` encoded preview strings (total cap `2 MiB`) are retained in an LRU cache for modal re-open, evicted automatically on `/clear` and `isFrugalPerf()`.

---

## 5. Phased Implementation Roadmap

### Phase 1: Synchronized Output & Inline Terminal Graphics (`@wrongstack/core`, `@wrongstack/tui`, `@wrongstack/tools`)
*Lowest cross-package coupling; delivers immediate perceived responsiveness and visual UX wins.*

1. **Capability & Mode Primitives:**
   - Extend `TerminalCapability` in [`packages/core/src/utils/terminal-capability.ts`](../../packages/core/src/utils/terminal-capability.ts) with `supportsSyncOutput` and `graphicsProtocol` + full unit test matrix across `$TERM` / `$TERM_PROGRAM` / ConPTY / conhost / tmux combinations.
   - Add `SYNC_OUTPUT_ON` / `SYNC_OUTPUT_OFF` in [`packages/tui/src/terminal-modes.ts`](../../packages/tui/src/terminal-modes.ts).
2. **Synchronized Stream Wrapper & Exit Safety:**
   - Implement `packages/tui/src/sync-stdout.ts` (`createSynchronizedStdout`) with microtask coalescing, `512 KiB` chunk flush ceiling, and bypass flag `WRONGSTACK_TUI_SYNC=0`.
   - Wire into [`packages/tui/src/run-tui.ts`](../../packages/tui/src/run-tui.ts), [`packages/tui/src/run-tui-mount.ts`](../../packages/tui/src/run-tui-mount.ts), and unconditional teardown reset in [`packages/tui/src/run-tui-exits.ts`](../../packages/tui/src/run-tui-exits.ts).
3. **Inline Graphics Codec & TUI Components:**
   - Implement `packages/tui/src/graphics/image-codec.ts` (PNG/JPEG/GIF/WebP header inspector, Kitty `q=2` chunker, iTerm2 `OSC 1337` encoder, pure-zlib PNG half-block sampler) and stdin APC filter guard.
   - Build `<StaticImageAttachment>` for committed tool results (`browser_screenshot`, `image_generate`, `present_artifact`) and `<ImagePreviewModal>` + `/image <path>` TUI slash command.

### Phase 2: Zero-Build TypeScript Plugins, Live `/plugin reload`, & `api.ui` (`@wrongstack/contracts`, `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/plugin-sdk`, `@wrongstack/tui`, `@wrongstack/webui`)

1. **Discovery & Closure TOFU:**
   - Extend [`packages/core/src/plugin/discovery.ts`](../../packages/core/src/plugin/discovery.ts) for `.ts`/`.mts` entries and deterministic directory precedence.
   - Add `hashPluginDirectoryClosure` to [`packages/core/src/plugin/trust.ts`](../../packages/core/src/plugin/trust.ts) with atomic `plugin-trust.json` migration-free compatibility.
2. **Runtime TS Loader & Hot-Swap Supervisor:**
   - Implement `packages/runtime/src/plugin-host/ts-module-loader.ts` (Bun native + standalone binary `@wrongstack/plugin-sdk` virtual bridge + Node type-strip fallback + `Loader.registry` cache eviction).
   - Upgrade [`packages/core/src/plugin/loader.ts`](../../packages/core/src/plugin/loader.ts) with `PluginRuntimeSupervisor` (`reloadPlugin`, quiescence gate, stage-before-teardown validation, rollback-on-setup-failure).
   - Wire `/plugin reload [name|*]` into [`packages/runtime/src/portable-commands/plugin.ts`](../../packages/runtime/src/portable-commands/plugin.ts) and remove the session restart requirement for external and toggleable plugins.
3. **Declarative `api.ui` & Compaction Hooks:**
   - Add `PluginUiAPI` and `CompactionExtensionHook` contracts in `@wrongstack/contracts` and `@wrongstack/plugin-sdk`, guarded in `packages/core/src/plugin/plugin-capability-wrap.ts`.
   - Render plugin status chips in TUI `StatusBar` and WebUI/Desktop footer; mount `PluginPanelOverlay` in TUI and WebUI activity sidebar.

### Phase 3: Content-Addressable Session Tree (`/tree`) & Branch Fold-Back (`@wrongstack/contracts`, `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/cli`, `@wrongstack/tui`, `@wrongstack/project-surfaces`)

1. **Contracts & Tree Replay Engine:**
   - Add `seq` and `branchId` attribution plus `branch_created`, `branch_switched`, `branch_folded`, and `branch_status_changed` to [`packages/contracts/src/types/session-events.ts`](../../packages/contracts/src/types/session-events.ts).
   - Implement `packages/core/src/storage/session-store/tree-replay.ts` and integrate with [`packages/core/src/storage/session-store.ts`](../../packages/core/src/storage/session-store.ts) while keeping `forkSession` working for cross-session exports.
   - Update `collectReachableManifestHashes` in `packages/core/src/storage/session-checkpoint-gc.ts` for multi-branch CAS reachability.
2. **Workspace Switch & One-Shot Fold Synthesizer:**
   - Implement `SessionTreeCoordinator` (`branch`, `switch`, `fold`, `archive`) with automatic departure `captureCheckpoint`, arrival `materializeCheckpoint`, `SecretScrubber` enforcement, and optional SAGE insight queuing.
3. **Multi-Surface `/tree` UX:**
   - Ship `/tree` portable slash command across CLI/REPL, `SessionTreeOverlay` in `@wrongstack/tui`, and branch selector + Session Story DAG lanes in `@wrongstack/project-surfaces` (WebUI + Desktop v2).

---

## 6. Verification, Performance Budgets, & Quality Gates

Every phase must pass `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun scripts/check-docs.mjs`, and `bun run check:architecture` before merge, plus the following targeted gates:

| Subsystem | Deterministic Verification & Benchmark Gate |
|---|---|
| **Session Tree Replay & GC** | Property-based Vitest suite generating random sequences of 50+ prompts, compactions, rewinds, 5-level nested branches, and branch folds; asserts byte-identical message reconstruction on every branch switch and 0 orphaned or prematurely swept `checkpointCas` blobs. Backward-compatibility snapshot tests on legacy v1.5.x `.jsonl` and `.jsonl.gz` sessions. |
| **Branch Fold Security** | Inject synthetic API keys / bearer tokens into tool outputs on an exploratory branch; assert `branch_folded.summaryMessage` persisted on disk and injected into parent context has 100% of secrets redacted by `SecretScrubber`. |
| **Zero-Build `.ts` & TOFU** | End-to-end fixture tests in `packages/core/tests/plugin/`: (1) single-file `.ts` discovery & load, (2) multi-file `.ts` directory closure tamper refusal when an imported helper `.ts` changes by 1 byte, (3) syntax error during `/plugin reload` leaves v1 running with 0 dropped tool calls, (4) 50 consecutive `/plugin reload` cycles leak `< 2 MiB` heap after GC. |
| **Declarative `api.ui`** | Capability-honesty rejection test (`capabilities.ui` omitted → `PluginError` on `api.ui.registerStatusChip`); malicious ANSI/OSC escape injection inside status chip/panel labels stripped to literal printable text; 1,000 updates/sec flood from a plugin throttled cleanly to 4 Hz. |
| **Synchronized Output (`DECSET 2026`)** | Byte-exact stream capture tests asserting every multi-chunk Ink frame and resize sequence begins with `\x1b[?2026h` and ends with `\x1b[?2026l`, and all 6 exit paths in `run-tui-exits.test.ts` emit `\x1b[?2026l` before `ALT_SCREEN_OFF`. |
| **Inline Terminal Graphics** | Fuzz/corrupt binary header tests (truncated PNG, polyglot HTML/PNG, oversized 10 MiB file, SVG rejection); verify Kitty encoder always sets `q=2` and `C=1`; run `bun run bench:tui-heap` soak with 40 sequential `browser_screenshot` renders confirming heap stays strictly within baseline ceiling. |

---

## 7. Risk Register & Mitigations

1. **Risk: Stale LSP / Codebase Index state after `/tree switch` materializes an older CAS workspace.**
   - *Mitigation:* `materializeCheckpoint` returns exact `writtenFiles` and `deletedFiles` arrays (`WorkspaceMaterializationResult` in [`packages/contracts/src/types/session.ts`](../../packages/contracts/src/types/session.ts)); `SessionTreeCoordinator` publishes a batch `workspace.files_materialized` event on `EventBus` so the LSP document syncer and WrongIndex incremental watcher invalidate those exact paths immediately.
2. **Risk: In-process `.ts` plugin leaves dangling `setInterval` or child process across `/plugin reload`.**
   - *Mitigation:* Documented in [Plugin Author Guide](../plugin-author-guide.md) (`teardown` contract) and reinforced by exposing an `AbortSignal` (`api.signal`) on `PluginAPI` that aborts automatically when the plugin unloads or reloads, allowing `fetch`, timers, and `spawn(..., { signal: api.signal })` to self-terminate without boilerplate cleanup code.
3. **Risk: Terminal emulators behind nested SSH / older `tmux` dropping or mangling large graphics escape sequences.**
   - *Mitigation:* Conservative capability detection (`isTmux` defaults away from raw `APC`/`OSC` unless explicitly opted in; `4 KiB` Kitty chunking; `256 KiB` encoded wire cap) paired with instant runtime toggle `/settings graphics off` and `WRONGSTACK_TUI_GRAPHICS=off`.
