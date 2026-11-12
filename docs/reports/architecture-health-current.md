# Architecture Health Report

**Generated:** 2026-11-12T06:59:27.074Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 48 |
| Production source files | 6276 |
| Production source lines | 1293087 |
| Test files | 5225 |
| Workspace dependency edges | 250 |
| Relative module edges | 18489 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 1 |
| Tests without TypeScript test-project coverage | 331 |
| Tests in multiple TypeScript projects | 1 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 57 | 67 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/agent-catalog | 44 | 13 | @wrongstack/contracts, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/bench | 32 | 65 | @wrongstack/core |
| @wrongstack/builtin-plugins | 33 | 28 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/chronicle | 53 | 45 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/cli | 637 | 700 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/bench, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/hq-next, @wrongstack/kanban, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/requirement-intake-mcp, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/vibeui, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/client | 7 | 4 | @wrongstack/webui-protocol |
| @wrongstack/codebase-index-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/contracts | 131 | 4 | @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/coordination | 192 | 190 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/core | 649 | 708 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop-v2 | 514 | 331 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/fleet | 62 | 4 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/providers, @wrongstack/sage, @wrongstack/sdd, @wrongstack/worktree |
| @wrongstack/goal | 24 | 25 | @wrongstack/contracts, @wrongstack/core, @wrongstack/worktree |
| @wrongstack/governance | 45 | 37 | @wrongstack/persistence |
| @wrongstack/hq | 73 | 51 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/hq-next | 193 | 67 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/hq, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/kanban | 108 | 100 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 7 | 11 | @wrongstack/coordination, @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 74 | 100 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/persistence | 10 | 23 | — |
| @wrongstack/plug-lsp | 52 | 58 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 12 | 10 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 154 | 131 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 25 | 39 | — |
| @wrongstack/project-surfaces | 259 | 0 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/providers, @wrongstack/tools |
| @wrongstack/providers | 138 | 125 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/requirement-intake | 18 | 20 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 6 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 124 | 49 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/governance, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/sage, @wrongstack/security-scanner, @wrongstack/telegram, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/sage | 177 | 176 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/hq, @wrongstack/persistence, @wrongstack/primitives, @wrongstack/wrongmemory-client |
| @wrongstack/sage-mcp | 7 | 7 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 44 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake, @wrongstack/worktree |
| @wrongstack/security-scanner | 21 | 34 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/techstack | 55 | 65 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 28 | 44 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/tools | 400 | 389 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 510 | 441 | @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 29 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/vibeui | 71 | 25 | @wrongstack/webui-protocol |
| @wrongstack/webui | 791 | 524 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-protocol | 29 | 15 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq |
| @wrongstack/webui-server | 351 | 395 | @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/worktree | 10 | 4 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/wrongmemory-client | 6 | 1 | — |
| @wrongstack/wrongtrace | 11 | 10 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/contracts/src/types/blocks.ts ↔ packages/contracts/src/types/context.ts ↔ packages/contracts/src/types/conversation-state.ts ↔ packages/contracts/src/types/messages.ts ↔ packages/contracts/src/types/provider.ts ↔ packages/contracts/src/types/run-env.ts ↔ packages/contracts/src/types/session-events.ts ↔ packages/contracts/src/types/session-storage.ts ↔ packages/contracts/src/types/session.ts ↔ packages/contracts/src/types/tool.ts

## Largest production files

| Lines | File |
|---:|---|
| 2069 | `apps/desktop-v2/src/FileWorkspace.tsx` |
| 1589 | `apps/desktop-v2/src/ProjectAgentRoster.tsx` |
| 1519 | `packages/core/src/execution/design-dna.ts` |
| 1216 | `packages/vibeui/src/components/workspace.tsx` |
| 1162 | `packages/core/src/execution/design-md.ts` |
| 1110 | `packages/project-surfaces/src/atlas/codemap-model.ts` |
| 1080 | `apps/desktop-v2/src/ProjectGoals.tsx` |
| 1072 | `apps/desktop-v2/src/SessionComposer.tsx` |
| 1061 | `packages/builtin-plugins/src/review-context-builder.ts` |
| 953 | `apps/desktop-v2/src/ProjectRequirements.tsx` |
| 940 | `apps/desktop-v2/src/ModelCatalogSettings.tsx` |
| 920 | `packages/webui/src/components/ChimeraReviewsView.tsx` |
| 903 | `packages/tools/src/codebase-index/infra-parser.ts` |
| 898 | `apps/desktop-v2/src/SkillLibrary.tsx` |
| 891 | `apps/desktop-v2/src/ProjectChimera.tsx` |
| 853 | `apps/desktop-v2/src/AutomationWorkspace.tsx` |
| 853 | `apps/desktop-v2/src/ProjectDesignStudio.tsx` |
| 853 | `packages/plugins/src/adversary-mode/evaluator.ts` |
| 832 | `apps/desktop-v2/src/ProjectMailbox.tsx` |
| 815 | `packages/vibeui/src/lib/session.ts` |
| 800 | `apps/desktop-v2/src/RosterRuntimeEditor.tsx` |
| 800 | `packages/vibeui/src/components/resource-hub.tsx` |
| 785 | `packages/client/src/client.ts` |
| 777 | `packages/webui-server/src/server/memory-handlers.ts` |
| 773 | `apps/desktop-v2/src/EngineWorkspace.tsx` |
| 763 | `packages/plugins/src/adversary-mode/index.ts` |
| 762 | `packages/vibeui/src/lib/use-session.ts` |
| 757 | `packages/tools/src/design-reference.ts` |
| 756 | `packages/fleet/src/host-skill-companion.ts` |
| 755 | `apps/desktop-v2/src/ProjectSdd.tsx` |
| 752 | `packages/acp/src/client/acp-session.ts` |
| 749 | `packages/builtin-plugins/src/review-claim-registry.ts` |
| 748 | `packages/coordination/src/sqlite-mailbox.ts` |
| 747 | `apps/desktop-v2/src/ProjectSessionHistory.tsx` |
| 745 | `packages/runtime/src/chimera/execution-chimera-review.ts` |
| 744 | `packages/tools/src/process-registry.ts` |
| 737 | `packages/webui-server/src/server/completion-handlers.ts` |
| 733 | `packages/vibeui/src/components/provider-manager.tsx` |
| 732 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 726 | `packages/coordination/src/multi-agent-coordinator.ts` |
| 726 | `packages/vector-memory/src/store.ts` |
| 724 | `packages/coordination/src/agent-monitor.ts` |
| 723 | `apps/desktop-v2/src/ProjectChronicle.tsx` |
| 720 | `packages/tools/src/read.ts` |
| 720 | `packages/webui-server/src/server/provider-routes.ts` |
| 719 | `packages/chronicle/src/project-server-client.ts` |
| 719 | `packages/mailbox-mcp/src/adapter.ts` |
| 718 | `packages/project-surfaces/src/sage/useMemoryManagerState.ts` |
| 716 | `packages/plugins/src/audit/index.ts` |
| 716 | `packages/requirement-intake/src/service.ts` |

## Exports only tests reference

- 1048 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 331 test files are not included in a package TypeScript test project.
- 1 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
