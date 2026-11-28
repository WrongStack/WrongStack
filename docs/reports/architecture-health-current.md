# Architecture Health Report

**Generated:** 2026-11-28T13:04:56.705Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 51 |
| Production source files | 6671 |
| Production source lines | 1368055 |
| Test files | 6596 |
| Workspace dependency edges | 268 |
| Relative module edges | 19577 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 1 |
| Tests without TypeScript test-project coverage | 25 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 69 | 99 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/agent-catalog | 44 | 23 | @wrongstack/contracts, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/bench | 33 | 70 | @wrongstack/core |
| @wrongstack/browser-tools | 14 | 28 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/builtin-plugins | 40 | 52 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/chronicle | 54 | 68 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/cli | 655 | 754 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/bench, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/hq-next, @wrongstack/kanban, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/requirement-intake-mcp, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/vibeui, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/client | 7 | 12 | @wrongstack/webui-protocol |
| @wrongstack/codebase | 115 | 24 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/codebase-index-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/contracts | 133 | 15 | @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/coordination | 193 | 248 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/core | 665 | 869 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop-v2 | 591 | 420 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/fleet | 65 | 41 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/providers, @wrongstack/requirement-intake-mcp, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/worktree |
| @wrongstack/goal | 24 | 40 | @wrongstack/contracts, @wrongstack/core, @wrongstack/worktree |
| @wrongstack/governance | 45 | 47 | @wrongstack/persistence |
| @wrongstack/hq | 93 | 96 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/hq-next | 206 | 104 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/hq, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/kanban | 110 | 132 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 7 | 12 | @wrongstack/coordination, @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 76 | 128 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/persistence | 10 | 31 | — |
| @wrongstack/plug-lsp | 52 | 74 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 12 | 18 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 170 | 175 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 27 | 55 | — |
| @wrongstack/project-surfaces | 280 | 59 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/providers | 142 | 163 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/requirement-intake | 18 | 24 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 6 | 5 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 135 | 105 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/governance, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/sage, @wrongstack/security-scanner, @wrongstack/telegram, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/sage | 179 | 203 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/hq, @wrongstack/persistence, @wrongstack/primitives, @wrongstack/tools, @wrongstack/wrongmemory-client |
| @wrongstack/sage-mcp | 7 | 7 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 69 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake, @wrongstack/worktree |
| @wrongstack/security-scanner | 21 | 45 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/techstack | 55 | 74 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 28 | 55 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/toolflow | 3 | 2 | @wrongstack/contracts |
| @wrongstack/tools | 352 | 421 | @wrongstack/agent-catalog, @wrongstack/browser-tools, @wrongstack/codebase, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives, @wrongstack/toolflow |
| @wrongstack/tui | 520 | 513 | @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 31 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/vibeui | 102 | 54 | @wrongstack/webui-protocol |
| @wrongstack/webui | 813 | 606 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-protocol | 31 | 21 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq |
| @wrongstack/webui-server | 366 | 456 | @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/worktree | 10 | 12 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/wrongmemory-client | 6 | 5 | — |
| @wrongstack/wrongtrace | 11 | 18 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/contracts/src/types/blocks.ts ↔ packages/contracts/src/types/context.ts ↔ packages/contracts/src/types/conversation-state.ts ↔ packages/contracts/src/types/messages.ts ↔ packages/contracts/src/types/provider.ts ↔ packages/contracts/src/types/run-env.ts ↔ packages/contracts/src/types/session-events.ts ↔ packages/contracts/src/types/session-storage.ts ↔ packages/contracts/src/types/session.ts ↔ packages/contracts/src/types/tool.ts

## Largest production files

| Lines | File |
|---:|---|
| 1589 | `apps/desktop-v2/src/ProjectAgentRoster.tsx` |
| 1519 | `packages/core/src/execution/design-dna.ts` |
| 1162 | `packages/core/src/execution/design-md.ts` |
| 1146 | `packages/acp/src/client/acp-session.ts` |
| 1118 | `packages/project-surfaces/src/atlas/codemap-model.ts` |
| 1080 | `apps/desktop-v2/src/ProjectGoals.tsx` |
| 1042 | `packages/webui/src/components/ChimeraReviewsView.tsx` |
| 998 | `apps/desktop-v2/src/SessionComposer.tsx` |
| 966 | `apps/desktop-v2/src/ProjectChimera.tsx` |
| 963 | `apps/desktop-v2/src/ModelCatalogSettings.tsx` |
| 957 | `apps/desktop-v2/src/ProjectRequirements.tsx` |
| 904 | `packages/codebase/src/infra-parser.ts` |
| 898 | `apps/desktop-v2/src/SkillLibrary.tsx` |
| 883 | `packages/builtin-plugins/src/review-followup-briefing.ts` |
| 878 | `apps/desktop-v2/src/ProjectDesignStudio.tsx` |
| 872 | `packages/builtin-plugins/src/review-claim-registry.ts` |
| 869 | `packages/acp/src/agent/server-agent-turn.ts` |
| 869 | `packages/runtime/src/chimera/execution-chimera-review.ts` |
| 864 | `packages/acp/src/agent/protocol-session-management.ts` |
| 855 | `packages/plugins/src/adversary-mode/evaluator.ts` |
| 854 | `apps/desktop-v2/src/AutomationWorkspace.tsx` |
| 853 | `packages/tools/src/design-reference.ts` |
| 848 | `packages/webui/src/components/DesignGalleryView.tsx` |
| 839 | `apps/desktop-v2/src/ProjectMailbox.tsx` |
| 831 | `packages/core/src/execution/design-draw.ts` |
| 816 | `packages/client/src/client.ts` |
| 800 | `apps/desktop-v2/src/RosterRuntimeEditor.tsx` |
| 800 | `packages/vibeui/src/components/resource-hub.tsx` |
| 792 | `apps/desktop-v2/src/EngineWorkspace.tsx` |
| 787 | `packages/plugins/src/branch-guard/index.ts` |
| 786 | `apps/desktop-v2/src/WrongStackSettings.tsx` |
| 786 | `packages/vibeui/src/lib/use-session.ts` |
| 780 | `packages/tools/src/design.ts` |
| 777 | `packages/mailbox-mcp/src/adapter.ts` |
| 777 | `packages/webui-server/src/server/memory-handlers.ts` |
| 770 | `packages/webui-server/src/server/provider-routes.ts` |
| 767 | `apps/desktop-v2/src/useFileWorkspace.ts` |
| 763 | `packages/plugins/src/adversary-mode/index.ts` |
| 762 | `packages/tui/src/reducers/panel-pickers.ts` |
| 761 | `packages/coordination/src/agent-monitor.ts` |
| 761 | `packages/coordination/src/multi-agent-coordinator.ts` |
| 760 | `packages/tools/src/read.ts` |
| 759 | `packages/coordination/src/sqlite-mailbox.ts` |
| 758 | `packages/tools/src/process-registry.ts` |
| 758 | `packages/vector-memory/src/store.ts` |
| 756 | `packages/fleet/src/host-skill-companion.ts` |
| 755 | `apps/desktop-v2/src/ProjectSdd.tsx` |
| 754 | `apps/desktop-v2/src/ProjectSessionHistory.tsx` |
| 744 | `packages/webui-server/src/server/completion-handlers.ts` |
| 741 | `packages/builtin-plugins/src/auto-review-plugin.ts` |

## Exports only tests reference

- 1064 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 25 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
