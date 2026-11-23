# Architecture Health Report

**Generated:** 2026-11-23T14:00:29.324Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 50 |
| Production source files | 6492 |
| Production source lines | 1328333 |
| Test files | 5769 |
| Workspace dependency edges | 259 |
| Relative module edges | 18987 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 1 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 58 | 74 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/agent-catalog | 44 | 15 | @wrongstack/contracts, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/bench | 32 | 67 | @wrongstack/core |
| @wrongstack/browser-tools | 14 | 22 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/builtin-plugins | 40 | 41 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/chronicle | 54 | 59 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/cli | 640 | 714 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/bench, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/hq-next, @wrongstack/kanban, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/requirement-intake-mcp, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/vibeui, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/client | 7 | 8 | @wrongstack/webui-protocol |
| @wrongstack/codebase | 115 | 0 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/codebase-index-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/contracts | 133 | 6 | @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/coordination | 193 | 211 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/core | 664 | 774 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop-v2 | 560 | 404 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/fleet | 63 | 24 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/providers, @wrongstack/sage, @wrongstack/sdd, @wrongstack/worktree |
| @wrongstack/goal | 24 | 32 | @wrongstack/contracts, @wrongstack/core, @wrongstack/worktree |
| @wrongstack/governance | 45 | 39 | @wrongstack/persistence |
| @wrongstack/hq | 73 | 59 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/hq-next | 193 | 70 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/hq, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/kanban | 108 | 111 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 7 | 11 | @wrongstack/coordination, @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 75 | 111 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/persistence | 10 | 28 | — |
| @wrongstack/plug-lsp | 52 | 63 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 12 | 12 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 156 | 149 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 27 | 47 | — |
| @wrongstack/project-surfaces | 263 | 36 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/providers, @wrongstack/tools |
| @wrongstack/providers | 138 | 133 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/requirement-intake | 18 | 21 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 6 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 126 | 79 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/governance, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/sage, @wrongstack/security-scanner, @wrongstack/telegram, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/sage | 179 | 181 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/hq, @wrongstack/persistence, @wrongstack/primitives, @wrongstack/tools, @wrongstack/wrongmemory-client |
| @wrongstack/sage-mcp | 7 | 7 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 56 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake, @wrongstack/worktree |
| @wrongstack/security-scanner | 21 | 36 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/techstack | 55 | 68 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 28 | 46 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/tools | 348 | 398 | @wrongstack/agent-catalog, @wrongstack/browser-tools, @wrongstack/codebase, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 517 | 460 | @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 29 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/vibeui | 100 | 42 | @wrongstack/webui-protocol |
| @wrongstack/webui | 798 | 543 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-protocol | 29 | 16 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq |
| @wrongstack/webui-server | 357 | 424 | @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/worktree | 10 | 9 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/wrongmemory-client | 6 | 4 | — |
| @wrongstack/wrongtrace | 11 | 13 | — |
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
| 1116 | `packages/project-surfaces/src/atlas/codemap-model.ts` |
| 1082 | `apps/desktop-v2/src/SessionComposer.tsx` |
| 1080 | `apps/desktop-v2/src/ProjectGoals.tsx` |
| 1042 | `packages/webui/src/components/ChimeraReviewsView.tsx` |
| 966 | `apps/desktop-v2/src/ProjectChimera.tsx` |
| 963 | `apps/desktop-v2/src/ModelCatalogSettings.tsx` |
| 957 | `apps/desktop-v2/src/ProjectRequirements.tsx` |
| 904 | `packages/codebase/src/infra-parser.ts` |
| 898 | `apps/desktop-v2/src/SkillLibrary.tsx` |
| 881 | `packages/acp/src/client/acp-session.ts` |
| 878 | `apps/desktop-v2/src/ProjectDesignStudio.tsx` |
| 877 | `packages/builtin-plugins/src/review-followup-briefing.ts` |
| 869 | `packages/runtime/src/chimera/execution-chimera-review.ts` |
| 864 | `packages/builtin-plugins/src/review-claim-registry.ts` |
| 853 | `apps/desktop-v2/src/AutomationWorkspace.tsx` |
| 853 | `packages/plugins/src/adversary-mode/evaluator.ts` |
| 853 | `packages/tools/src/design-reference.ts` |
| 848 | `packages/webui/src/components/DesignGalleryView.tsx` |
| 839 | `apps/desktop-v2/src/ProjectMailbox.tsx` |
| 831 | `packages/core/src/execution/design-draw.ts` |
| 800 | `apps/desktop-v2/src/RosterRuntimeEditor.tsx` |
| 800 | `packages/client/src/client.ts` |
| 800 | `packages/vibeui/src/components/resource-hub.tsx` |
| 792 | `apps/desktop-v2/src/EngineWorkspace.tsx` |
| 786 | `packages/vibeui/src/lib/use-session.ts` |
| 781 | `apps/desktop-v2/src/WrongStackSettings.tsx` |
| 780 | `packages/tools/src/design.ts` |
| 777 | `packages/webui-server/src/server/memory-handlers.ts` |
| 774 | `packages/runtime/src/acp-leader/acp-leader-provider.ts` |
| 763 | `packages/plugins/src/adversary-mode/index.ts` |
| 761 | `packages/coordination/src/agent-monitor.ts` |
| 760 | `packages/tools/src/read.ts` |
| 758 | `packages/vector-memory/src/store.ts` |
| 756 | `packages/fleet/src/host-skill-companion.ts` |
| 755 | `apps/desktop-v2/src/ProjectSdd.tsx` |
| 754 | `apps/desktop-v2/src/ProjectSessionHistory.tsx` |
| 753 | `apps/desktop-v2/src/useFileWorkspace.ts` |
| 748 | `packages/coordination/src/sqlite-mailbox.ts` |
| 744 | `packages/tools/src/process-registry.ts` |
| 744 | `packages/webui-server/src/server/completion-handlers.ts` |
| 741 | `packages/builtin-plugins/src/auto-review-plugin.ts` |
| 741 | `packages/project-surfaces/src/analytics/AnalyticsDashboard.tsx` |
| 739 | `packages/tools/src/bash-kill-guard.ts` |
| 733 | `packages/vibeui/src/components/provider-manager.tsx` |
| 732 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 730 | `apps/desktop-v2/src/ProjectChronicle.tsx` |
| 730 | `packages/acp/src/agent/server-agent-turn.ts` |

## Exports only tests reference

- 1041 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
