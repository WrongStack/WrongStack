# @wrongstack/core — Checkup Report

> Generated: 2026-07-24 (updated after actions; 2026-07-31: `BUNDLED_AGENT_SKILLS` exported + test-covered, reclassified DEAD → EXPORTED)
> Scope: `packages/core` (495 source files, ~472 test files, 1,519 total files)
> Some files were modified as part of the HQ audit and barrel conversion — see action logs below.

---

## Table of Contents

1. [Code Health Snapshot](#1-code-health-snapshot)
2. [Dead Code Analysis — HQ Module](#2-dead-code-analysis--hq-module)
3. [Dead Code Analysis — Other Subsystems](#3-dead-code-analysis--other-subsystems)
4. [Public API Surface Audit](#4-public-api-surface-audit)
5. [Dependency Analysis](#5-dependency-analysis)
6. [Test Health](#6-test-health)
7. [File Complexity Hotspots](#7-file-complexity-hotspots)
8. [Prioritized Action Plan](#8-prioritized-action-plan)

---

## 1. Code Health Snapshot

| Check | Result |
|-------|--------|
| TypeScript (`tsc --noEmit`) | ✅ 0 errors, 0 warnings |
| Biome lint | ✅ 0 errors, 0 warnings |
| Duplicate code | ✅ No significant duplication |
| Test-to-source ratio | ✅ ~472 tests / 495 source files |
| Lockfile audit | ⚠️ Skipped (no lockfile at package level) |

**Verdict:** Core is type-safe, lint-clean, and well-tested. The improvement opportunities below are about maintainability, dead code removal, and API surface hygiene — not about bugs or breakage.

---

## 2. Dead Code Analysis — HQ Module

### 2.1 Architecture Overview

The `src/hq/` module is a **Headquarters protocol and telemetry subsystem** that:

1. Defines wire protocols for HQ WebSocket communication
2. Implements a WebSocket publisher (`HqPublisher`)
3. Provides telemetry bridges that forward events (session, fleet, brain, tool, cost, worktree) from the EventBus to HQ
4. Contains persistence, auth, alerting, and command infrastructure

The `@wrongstack/core/hq` subpath export in `package.json` exposes the entire module as a public API:

```json
"./hq": {
  "types": "./dist/hq/index.d.ts",
  "import": "./dist/hq/index.js"
}
```

The barrel (`src/hq/index.ts`) re-exports everything via 19 `export *` lines.

### 2.2 External Consumers

**Confirmed external consumers of `@wrongstack/core/hq`:**

| Package | Files importing from `@wrongstack/core/hq` | What they import |
|---------|-------------------------------------------|------------------|
| `packages/cli` | `src/hq-publisher.ts`, `src/wiring/hq-telemetry.ts` | `HqPublisher`, `HqSocketLike`, `createHqPublisherFromEnv`, `resolveHqConfig`, `CreateHqPublisherOptions`, `startSessionTelemetryBridge`, `startFleetTelemetryBridge`, `startBrainTelemetryBridge`, `startWorktreeTelemetryBridge`, `startToolTelemetryBridge`, `startCostTelemetryBridge` |
| `packages/webui-server` | `src/protocol/projections.ts`, `src/server/client-presence.ts`, `src/server/standalone-session-identity.ts` | `HqAlertMessage`, `HqCommandAuditEntry`, `HqEventEnvelope`, `HqSnapshot`, `startSessionTelemetryBridge`, `CreateHqPublisherOptions`, `HqClientCapability`, `HqPublisher`, `HqSocketLike` |
| `packages/webui-hq` | ~20 files in `src/views/`, `src/lib/`, `src/store.ts` | Protocol types only: `HqSnapshot`, `HqEventEnvelope`, `HqAlertMessage`, `HqCommandAuditEntry`, `HqTranscriptEntry`, `HqRedactionPolicy`, `HqBrowserMessage`, `HqBrainEventPayload`, `HqClientRecord`, `HqKanbanSnapshotPayload`, `HqMailboxMessageType`, `HqMailboxPriority`, `HqTimeseriesBreakdownEntry`, `HqTimeseriesSample`, `HqWorktreeEventPayload`, `HqFleetPayload`, `HqAlert` |

### 2.3 Classification Per File

Each file in `src/hq/` is classified as:

- **🟢 EXTERNAL** — consumed from outside `packages/core`
- **🟡 INTERNAL** — used only within `packages/core` (by source or tests)
- **🔴 DEAD** — not consumed anywhere (except own tests)
- **🔵 PROTOCOL** — contains type definitions consumed externally; runtime code may not be

#### `/src/hq/protocol/` — Wire Protocol Types

| File | Status | External Consumers |
|------|--------|-------------------|
| `protocol/client.ts` | 🟢 EXTERNAL | `HqClientCapability`, `HqClientRecord` used by webui-server, webui-hq |
| `protocol/session.ts` | 🟢 EXTERNAL | Session status types used by webui-hq |
| `protocol/mailbox.ts` | 🟢 EXTERNAL | `HqMailboxMessageType`, `HqMailboxPriority` used by webui-hq |
| `protocol/fleet.ts` | 🟢 EXTERNAL | Fleet/worktree types used by webui-hq |
| `protocol/brain.ts` | 🟢 EXTERNAL | `HqBrainEventPayload` used by webui-hq |
| `protocol/tool.ts` | 🟢 EXTERNAL | `HqRedactionPolicy`, `HQ_TRANSCRIPT_TEXT_CAP` used by webui-hq, tests |
| `protocol/browser.ts` | 🟢 EXTERNAL | `HqBrowserMessage` used by webui-hq |
| `protocol/kanban.ts` | 🟢 EXTERNAL | `HqKanbanSnapshotPayload`, `HqKanbanBoardRecord`, `HqProjectRecord` used by webui-hq |
| `protocol/core.ts` | 🟢 EXTERNAL | `HqSnapshot`, `HqEventEnvelope`, `HqAlertMessage`, `HqCommandAuditEntry`, `HqTranscriptEntry`, `HqTimeseriesSample`, `HqTimeseriesBreakdownEntry`, `HqServerMessage` — used by ALL external consumers |
| `protocol/project.ts` | 🟡 INTERNAL | Project types — likely only used by publisher internally |

#### `/src/hq/` — Runtime Code

| File | Status | External Consumers | Notes |
|------|--------|-------------------|-------|
| `publisher.ts` | 🟢 EXTERNAL | `HqPublisher`, `HqSocketLike`, `createHqPublisherFromEnv` used by CLI, webui-server | Core connection logic |
| `factory.ts` | 🟢 EXTERNAL | `resolveHqConfig`, `CreateHqPublisherOptions` used by CLI, webui-server | Config resolution |
| `session-bridge.ts` | 🟢 EXTERNAL | `startSessionTelemetryBridge` used by CLI, webui-server | |
| `fleet-bridge.ts` | 🟢 EXTERNAL | `startFleetTelemetryBridge` used by CLI | |
| `brain-bridge.ts` | 🟢 EXTERNAL | `startBrainTelemetryBridge` used by CLI | |
| `worktree-bridge.ts` | 🟢 EXTERNAL | `startWorktreeTelemetryBridge` used by CLI | |
| `tool-bridge.ts` | 🟢 EXTERNAL | `startToolTelemetryBridge` used by CLI | |
| `cost-bridge.ts` | 🟢 EXTERNAL | `startCostTelemetryBridge` used by CLI | |
| `bridge-context.ts` | 🟡 INTERNAL | `createBridgeContext` is consumed by five HQ bridge modules | Keep internal; do not remove without migrating those consumers |
| `transcript-mapper.ts` | 🟢 EXTERNAL | `buildTranscriptFromEvents` is imported by the CLI HQ server and core tests; `mergeToolResults` supports it internally | Keep exported until the CLI consumer is migrated to a supported subpath |
| `mailbox-mapper.ts` | 🟡 INTERNAL | Consumed by `publisher.ts` internally | Should not be public API |
| `auth-store.ts` | 🟡 INTERNAL | ~20 exports consumed only by tests and `auth-audit.ts`. Not imported by any external package | Should not be public API |
| `auth-audit.ts` | 🟡 INTERNAL | Consumed only by tests | Should not be public API |
| `exposure.ts` | 🟡 INTERNAL | `assessHqExposure`, `isLoopbackHost`, `isOpenMode` consumed only by tests | Should not be public API |
| `commands.ts` | 🟡 INTERNAL | 15+ command types and `validateHqCommand` consumed only by tests | Should not be public API |
| `alerts.ts` | 🟡 INTERNAL | `HqAlertEngine`, `toAlertMessage` consumed only by tests. (Note: `HqAlert` type is from `protocol/core.ts`, not this file) | Should not be public API |
| `redaction.ts` | 🟡 INTERNAL | `tightenHqRedactionPolicy`, `redactHqValue` consumed only by tests | Should not be public API |
| `persistence.ts` | 🟡 INTERNAL | `HqEventLog`, `HqSnapshotStore`, `HqKanbanStore`, `HqTimeseriesStore`, `HqSimpleLog`, `HqPersistence`, `createHqPersistence` — 7 classes consumed only by tests | Should not be public API |

#### 2.4 Recommended Actions

| Action | File | Detail |
|--------|------|--------|
| Migrate before narrowing the barrel | `bridge-context.ts` | Five HQ bridge modules consume `createBridgeContext`; keep the current export until those imports use a supported internal subpath |
| Preserve the public CLI dependency | `transcript-mapper.ts` | The CLI HQ server imports `buildTranscriptFromEvents` from `@wrongstack/core/hq`; `mergeToolResults()` remains part of that implementation |
| Audit before removing barrel exports | `auth-audit.ts`, `auth-store.ts`, `exposure.ts`, `commands.ts`, `alerts.ts`, `redaction.ts`, `persistence.ts`, `mailbox-mapper.ts` | `hq/index.ts` still contains all 19 wildcard exports; migrate workspace consumers and verify the published API before narrowing it |
| Verify any future cleanup | `packages/core` | Run the project typecheck and linter after changing the public export surface |

### 2.5 HQ Module Summary

```
┌─────────────────────────────────────────────────────┐
│                    HQ Module                         │
│  src/hq/ (21 files, 3000+ lines)                    │
├─────────────────────────────────────────────────────┤
│                                                      │
│  🟢 EXTERNAL (externally consumed, keep public)      │
│  ├── protocol/ (10 files — type definitions)         │
│  ├── publisher.ts                                    │
│  ├── factory.ts                                      │
│  ├── session-bridge.ts → fleet/tool/cost/brain/     │
│  │   worktree/bridge.ts (7 bridge files)            │
│                                                      │
│  🟡 INTERNAL (keep in core but remove from public    │
│  │   barrel or restrict exports)                     │
│  ├── auth-store.ts, auth-audit.ts                    │
│  ├── exposure.ts                                     │
│  ├── commands.ts                                     │
│  ├── alerts.ts                                       │
│  ├── redaction.ts                                    │
│  ├── persistence.ts                                  │
│  └── mailbox-mapper.ts                               │
│                                                      │
│  🟡 INTERNAL / SHARED (migrate before narrowing)     │
│  ├── bridge-context.ts (used by HQ bridge modules)   │
│  └── transcript-mapper.ts (used by CLI HQ server)    │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**Actionable estimate:**
- **2 shared files** (`bridge-context.ts`, `transcript-mapper.ts`) → keep until current bridge and CLI consumers are migrated
- **8 internal candidates** → audit and migrate consumers before removing them from the public `hq/index.ts` barrel
- **11 files** (protocol types + publisher + factory + 7 bridges) → keep as public API

---

## 3. Dead Code Analysis — Other Subsystems

### 3.1 Coordination Module

| Symbol | File | Status | Notes |
|--------|------|--------|-------|
| `ROLE_DISPATCHER_METAS` | `coordination/agents/index.ts:57` | 🔴 DEAD | Built as combined lookup table, never imported externally |
| `WAVE_ROLE_IDS` | `coordination/agents/index.ts:65` | 🔴 DEAD | Set of wave role IDs, never imported externally |
| `TECHSTACK_AGENTS` | `coordination/agents/phase3-techstack.ts:14` | 🔴 DEAD | Agent definition array, never imported |
| `ProjectAgentLearnStats` | `coordination/agents/project-agent-identity.ts:1095` | 🔴 DEAD | Type at line 1095, never referenced externally |
| `BUNDLED_AGENT_SKILLS` | `coordination/agents/role-skills.ts:9` | ✅ EXPORTED | Exported 2026-07-31 (skill-system Phase 2); consumed by the role-skills integrity test (`tests/coordination/role-skills.test.ts`) — no longer dead |
| `CatalogRoleWithSkills` | `coordination/agents/role-skills.ts:300` | 🔴 DEAD | Type alias, never imported externally |
| `DirectorCheckpointHost` | `coordination/checkpoint-wiring.ts:31` | 🔴 DEAD | Interface, never imported |
| `DEFAULT_MAX_TARGET_FILES` | `coordination/collab-debug.ts:44` | 🔴 DEAD | Constant, never imported |
| `hintForKind` | `coordination/delegate-tool.ts:708` | 🔴 DEAD | Helper function, never imported |
| `DirectorSpawnPort` | `coordination/director-host-contracts.ts:20` | 🔴 DEAD | Interface |
| `DirectorBudgetPort` | `coordination/director-host-contracts.ts:29` | 🔴 DEAD | Interface |
| `DirectorBudgetPolicyDeps` | `coordination/director/director-budget-policy.ts:15` | 🔴 DEAD | Type |
| `DirectorTaskRegistryDeps` | `coordination/director/director-task-registry.ts:17` | 🔴 DEAD | Type |
| `SettledTask` | `coordination/director/director-task-registry.ts:36` | 🔴 DEAD | Type |
| `HTTP_RATE_LIMIT_PER_MINUTE` | `coordination/mailbox-constants.ts:80` | 🔴 DEAD | Constant |
| `parseMailboxMessage` | `coordination/mailbox-message-codec.ts:197` | 🔴 DEAD | Function exported but only used within the same module |
| `MailboxTypeCategory` | `coordination/mailbox-types.ts:168` | 🔴 DEAD | Type + 2 derived helpers |
| `ACTIONABLE_BACKGROUND_TYPES` | `coordination/mailbox-types.ts:314` | 🔴 DEAD | Constant |
| `mailboxTypeCategory` | `coordination/mailbox-types.ts:326` | 🔴 DEAD | Function |
| `mailboxTypeExpectsReply` | `coordination/mailbox-types.ts:333` | 🔴 DEAD | Function |
| `getAllNicknameKeys` | `coordination/subagent-nicknames.ts:184` | 🔴 DEAD | Function |

### 3.2 Core Module

The **entire** `core/streaming-response-builder.ts` file appears to be dead code externally (15 of 18 exports unused in source):

`buildResponse`, `createStreamingState`, `handleMessageStart`, `handleContentBlockStart`, `handleContentBlockStop`, `handleTextDelta`, `handleToolUseStart`, `handleToolUseInputDelta`, `safeJsonOrRaw`, `handleToolUseStop`, `handleThinkingStart`, `handleThinkingDelta`, `handleThinkingSignature`, `handleThinkingStop`, `handleMessageStop`

Also in `core/`:
- `setAutonomousContinue`, `clearAutonomousContinue` from `continue-to-next-iteration.ts`

### 3.3 Execution Module

**autonomy-brain.ts (~10 symbols):**
`resolveRiskCeiling`, `quickDecide`, `withDecisionDigest`, `BrainLlmCallResult`, `BrainLlmDenyKind`, `readLlmDenyKind`, `extractConfidence`, `isNonAnswer`, `BrainFreeTextEnvelope`, `parseFreeTextDecision`

**compaction-core.ts:**
`HardBudgetResult`, `DedupResult`, `hasLargeToolResult`, `findExchangeStart`

**design-materialize.ts:**
`lightTheme`, `darkTheme`, `scale`, `ThemeTokens`

**prompt-enhancer.ts:**
`RefinerCompletionOptions`, `completeRefinerPass`

**tool-executor.ts:**
`classifyToolError`

### 3.4 Types Module

Due to aggressive `export * from './types/*'` in `src/types/index.ts`, every type from 55 type files is publicly exported. Many are likely internal-only implementation details that should not be part of the public API:

- `agent-bridge.ts`, `attachment.ts`, `autonomy.ts`, `compactor.ts`, `context-evidence.ts`, `error-handler.ts`, `file-event-record.ts`, `hooks.ts`, `input-reader.ts`, `mode-prompts.ts`, `one-shot-llm.ts`, `path-resolver.ts`, `permission.ts`, `provider-runner.ts`, `retry-policy.ts`, `secret-scrubber.ts`, `selector.ts`, `session-reader.ts`, `session-rewinder.ts`, `slash-command.ts`, `system-prompt-contributor.ts`, `system-prompt.ts`, `token-counter.ts`, `tool-markers.ts`, `utility-types.ts`

Notably:
- `DistributiveOmit` in `utility-types.ts` — unused type utility
- `BUILTIN_PROMPT_CATEGORIES`, `PromptManifest`, `PromptManifestRef` in `prompt.ts` — potentially unused
- Many config sub-types in `config.ts` that are only used internally for config parsing

### 3.5 Estimated Dead Code Volume

| Subsystem | Symbols | % of file |
|-----------|---------|-----------|
| HQ module | ~50 symbols | ~40% of HQ |
| Coordination | ~25 symbols | ~5% of coordination |
| Core | ~18 symbols | ~15% of core/ |
| Execution | ~20 symbols | ~5% of execution |
| Types | ~30 symbols | ~10% of types |
| **Total (estimated)** | **~140 symbols** | |

---

## 4. Public API Surface Audit

### 4.1 Subpath Exports

The `package.json` defines **22 subpath exports**, each mapping to a barrel file:

```
. (index.ts)
./agent (core/index.ts)
./agent-catalog (coordination/agents/index.ts)
./chronicle
./coordination
./defaults
./design
./execution
./extension
./goal
./hooks
./hq
./infrastructure
./kernel
./models
./notifications
./observability
./plugin
./registry
./replay
./security
./skills
./storage
./tasking
./tools
./types
./utils
./utils/expect-defined
./utils/error
./worktree
```

Every single one of these uses `export *` internally — meaning **every export from every file in these directories is publicly visible**. This is the root cause of the dead code noise: the static analyzer can't distinguish between "exported for external consumers" and "leaked through a barrel."

### 4.2 src/index.ts — The Mega-Barrel

`src/index.ts` is **935 lines** long and re-exports from 20+ submodules, mostly with `export *`. It also contains inline re-exports of specific symbols (e.g., boot types, brain interfaces, agent factory types). This file has grown organically with no clear boundary between public API and internal implementation.

**Example pattern — over-exposure:**
```typescript
// src/index.ts line 8
export * from './chronicle/index.js';
// This exports EVERYTHING from chronicle, including internal helpers
```

### 4.3 Recommendation

Replace `export *` with explicit named re-exports for the committed public API. An `internal.ts` file per submodule can collect internal-only symbols that are not re-exported. This is the single most impactful change for:

1. Making dead code analyzable by tools
2. Stabilizing the semver contract (accidental breaking changes from removed internal exports)
3. Reducing maintenance surface area

---

## 5. Dependency Analysis

### 5.1 Missing Dependencies

`depcheck` found:

| Dependency | Used in | Issue |
|------------|---------|-------|
| `@types/vitest` | `tsconfig.test.json` | Referenced in tsconfig but absent from `package.json` devDependencies |
| `undici` | `src/utils/dispatcher-types.d.ts` | Type declarations reference `undici` types but it's not declared as dependency |
| `@wrongstack/core` | `tests/hq/auth-audit.test.ts` | Self-import within the package; should use relative imports |

**Severity:** Low. Works via pnpm hoisting, but violates isolation best practices.

### 5.2 Runtime Dependencies

Only 2 runtime dependencies:
- `@wrongstack/kanban`
- `@wrongstack/persistence`

To check: whether these are actually needed at runtime or could be peer/dev dependencies.

---

## 6. Test Health

### 6.1 Structure

```
tests/
├── architecture/      (9 files)
├── chronicle/         (14 files)
├── coordination/      (90+ files)
├── core/              (30+ files)
├── execution/         (45+ files)
├── goal/              (8 files)
├── hooks/             (3 files)
├── hq/                (24 files)
├── infrastructure/    (6 files)
├── kernel/            (4 files)
├── models/            (7 files)
├── notifications/     (2 files)
├── observability/     (7 files)
├── perf/              (8 bench files)
├── plugin/            (7 files)
├── plugins/           (10 files)
├── prompts/           (2 files)
├── registry/          (3 files)
├── replay/            (3 files)
├── security/          (15 files)
├── skills/            (6 files)
├── storage/           (50+ files)
├── tools/             (6 files)
├── types/             (6 files)
├── utils/             (50+ files)
├── worktree/          (1 file)
├── root-level tests   (9 files)
```

### 6.2 Observations

| Pattern | Implication |
|---------|-------------|
| `coverage-batch-*.test.ts` (10 files) in `tests/utils/` | Test gaps are being retroactively patched in batches, suggesting test-after rather than test-first |
| `*-extra.test.ts` files (40+ across subsystems) | Tests were added later as extras rather than consolidated into the main test file |
| 9 root-level test files | These don't follow the subsystem directory pattern (e.g., `tests/boot.test.ts`, `tests/agent-status-tracker.test.ts`) |
| **Positive:** ~472 tests for ~495 source files | Very healthy ratio |

---

## 7. File Complexity Hotspots

Files that are disproportionately large for their role:

| File | Size (est.) | Concern |
|------|-------------|---------|
| `src/types/config.ts` | ~1700+ lines | Single monolithic config type file. All config fields, their validation, and nested types in one place |
| `src/index.ts` | 935 lines | Mega-barrel that re-exports everything |
| `src/execution/tool-executor.ts` | 1250+ lines | Large file with tool execution, error classification, hooks |
| `src/execution/compaction-core.ts` | 1200+ lines | Complex compaction logic mixed with multiple exported utilities |
| `src/coordination/mailbox.ts` | ~1000+ lines | Large file — mailbox is complex but could benefit from splitting |
| `src/core/system-prompt-builder.ts` | ~600+ lines | Growing system prompt construction logic |

---

## 8. Recommended Public API Cleanup

### 8.1 HQ Module

`src/hq/index.ts` currently contains 19 wildcard exports. The proposed reduction to a smaller, explicitly reviewed public surface has not yet been applied; internal modules must remain exported until their production and test consumers are migrated to supported subpaths.

### 8.2 Core Barrel

`src/index.ts` currently retains 12 wildcard exports. Replacing them with explicit named exports remains a recommendation, not a completed action. Any future cleanup must preserve the published `@wrongstack/core` API and be verified against all workspace consumers with the project typecheck and linter.

### 8.3 Dead Export Pruning — autonomy-brain.ts

**`src/execution/autonomy-brain.ts`:** Removed `export` from 3 types that had zero external or test consumers — they were only used as internal type annotations.

| Removed export | Reason |
|----------------|--------|
| `BrainLlmCallResult` | Only used as return type of `completeBrainLlm()`. Not imported by any test. |
| `BrainLlmDenyKind` | Only used internally for type annotations. Not imported by any test. |
| `BrainFreeTextEnvelope` | Only used as return type of `parseFreeTextDecision()`. Not imported by any test. |

**Exports kept (7):** `resolveRiskCeiling`, `quickDecide`, `withDecisionDigest`, `extractConfidence`, `isNonAnswer`, `parseFreeTextDecision`, `readLlmDenyKind` — all imported by test files.

**`src/core/streaming-response-builder.ts`:** **No changes made.** All 15 exports flagged by the dead code scanner are imported by `tests/core/streaming-response-builder.test.ts`. They are test-supporting exports, not dead code.

**Verification:**
- `tsc --noEmit` ✅ 0 errors, 0 warnings

### 8.4 Types Audit — Unused Public Type Exports

**Method:** Grep each of the ~370 type exports from `types/index.js` across the entire monorepo to measure actual consumption. Types with hits only in their declaration file + the barrel (3 hits or fewer, none outside `core/src/`) are truly dead exports.

**Findings — 9 exported types in `types/` with zero external consumers:**

| Type | File | Notes |
|------|------|-------|
| `BridgeMessageType` | `types/agent-bridge.ts` | 2 hits (declaration only) |
| `ContextFileEvidence` | `types/context-evidence.ts` | 3 hits (declaration + barrel) |
| `ContextIntentEvidence` | `types/context-evidence.ts` | 3 hits (declaration + barrel) |
| `ContextRepeatedReadEvidence` | `types/context-evidence.ts` | 3 hits (declaration + barrel) |
| `ToolEvidenceStatus` | `types/context-evidence.ts` | 3 hits (declaration + barrel) |
| `SideEffectRisk` | `types/side-effect.ts` | 3 hits (declaration + barrel) |
| `SerializableTaskGraphNodes` | `types/task-graph.ts` | 3 hits (declaration + barrel) |
| `PluginRuntime` | `types/plugin.ts` | 3 hits (declaration + barrel) |
| `ManifestValidation` | `types/prompt-registry.ts` | 3 hits (declaration + barrel) |

These types are part of the public API (exported via `types/index.ts` and re-exported through `src/index.ts`) but nothing in the monorepo imports them. They are candidates for:
1. Removal from the public barrel (move to internal-only in `types/index.ts`)
2. Keeping only if external consumers (outside this monorepo) depend on them

**Note:** The dead code scanner flagged ~200 types but >95% were false positives — types used across the project but not detected due to the scanner's limited scope. The 9 above were verified via cross-project grep.

### 8.5 Chimera Fix — boot.test.ts Mock Reset

**Medium finding from chimera-review:** `packages/core/tests/boot.test.ts` `beforeEach` did not reset `renameMock`, causing inter-test pollution for the "writes the project meta file atomically" test.

**Fix:** Added `renameMock.mockClear()` to `beforeEach` hook alongside the existing `mkdirMock.mockClear()` and `writeFileMock.mockClear()` calls.

---

## 9. Updated Prioritized Action Plan

### Completed and audited items

| Item | Status |
|------|--------|
| HQ public API cleanup | Recommended; 19 wildcard exports remain |
| Dead export pruning in transcript-mapper.ts | Recommended; exports remain |
| Core barrel explicit named re-exports | Recommended; 12 wildcard exports remain |
| autonomy-brain.ts dead export pruning (3 types internalized) | ✅ Done |
| Type audit — identified 9 dead public type exports | ✅ Audited |
| boot.test.ts mock reset fix | ✅ Done |

### Remaining P1–P5

**P1 — Convert remaining `export *` in sub-barrels:**
- `src/types/index.ts` still uses `export *` from 38 type files — convert to explicit named re-exports (this would automatically exclude the 9 dead types identified above)
- `src/coordination/index.ts` — still uses `export *` from sub-barrels within it

**P2 — Prune other confirmed-dead exports** (~30 symbols remaining):

| File | Symbols to remove from exports |
|------|-------------------------------|
| `coordination/agents/index.ts` | `ROLE_DISPATCHER_METAS`, `WAVE_ROLE_IDS` |
| `coordination/director-host-contracts.ts` | `DirectorSpawnPort`, `DirectorBudgetPort` |
| `coordination/mailbox-constants.ts` | `HTTP_RATE_LIMIT_PER_MINUTE` |
| `coordination/mailbox-message-codec.ts` | `parseMailboxMessage` |
| `coordination/mailbox-types.ts` | `MailboxTypeCategory` + 3 helpers |
| `coordination/subagent-nicknames.ts` | `getAllNicknameKeys` |
| `execution/design-materialize.ts` | `lightTheme`, `darkTheme`, `scale`, `ThemeTokens` |
| `types/` — 9 dead type exports | Remove from `types/index.ts` barrel |
| `utils/config-backup.ts` | `ConfigBackupPaths` (only used internally) |

**P3 — Declare missing dependencies:**
- `"@types/vitest"` in devDependencies
- `"undici"` or replace with native types

**P4 — Consolidate coverage-batch test files:**
- Merge `tests/utils/coverage-batch-*.test.ts` (10 files)

**P5 — Move root-level tests into subsystem directories:**
- Move 8 test files from `tests/*.test.ts` to appropriate subdirectories



---

## Quick Reference — HQ File Status (Current)

```
File                           Status   External Consumers
────────────────────────────────────────────────────────────
hq/index.ts (barrel)            ⚠️       19 wildcard exports; cleanup recommended
hq/publisher.ts                 🟢      CLI, webui-server
hq/factory.ts                   🟢      CLI, webui-server
hq/session-bridge.ts            🟢      CLI, webui-server
hq/fleet-bridge.ts              🟢      CLI
hq/brain-bridge.ts              🟢      CLI
hq/worktree-bridge.ts           🟢      CLI
hq/tool-bridge.ts               🟢      CLI
hq/cost-bridge.ts               🟢      CLI
hq/protocol/*.ts (10 files)     🟢      webui-server, webui-hq
hq/bridge-context.ts            🟡      Internal (5 bridge files consume createBridgeContext)
hq/transcript-mapper.ts         🟢      CLI HQ server, core tests
hq/auth-store.ts / auth-audit   🟡      Internal only
hq/exposure.ts / commands.ts    🟡      Internal only
hq/alerts.ts / redaction.ts     🟡      Internal only
hq/persistence.ts               🟡      Internal only
hq/mailbox-mapper.ts            🟡      Internal only
```

---

*Some files modified during analysis — see the audited items and recommendations above for details.*
