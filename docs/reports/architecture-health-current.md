# Architecture Health Report

**Generated:** 2026-11-04T15:21:48.109Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 48 |
| Production source files | 5986 |
| Production source lines | 1246223 |
| Test files | 4974 |
| Workspace dependency edges | 240 |
| Relative module edges | 17494 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 1 |
| Tests without TypeScript test-project coverage | 237 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- packages/core/src/storage/file-session-writer.ts: hotspot grew from 707 to 709 lines; review and update the ratchet in the same change
- packages/core/src/session-catalog/store-agents.ts: "readSessionAgentRows" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/core/src/session-catalog/store-rebuild.ts: "summarizeTranscriptFile" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 54 | 60 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/agent-catalog | 44 | 12 | @wrongstack/contracts, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/bench | 32 | 64 | @wrongstack/core |
| @wrongstack/builtin-plugins | 33 | 28 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/chronicle | 52 | 43 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/cli | 628 | 685 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/bench, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/hq-next, @wrongstack/kanban, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/requirement-intake-mcp, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/vibeui, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/worktree, @wrongstack/wrongtrace |
| @wrongstack/client | 7 | 4 | @wrongstack/webui-protocol |
| @wrongstack/codebase-index-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/contracts | 129 | 4 | @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/coordination | 190 | 184 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/core | 639 | 698 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop-v2 | 425 | 237 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/fleet | 59 | 2 | @wrongstack/acp, @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/providers, @wrongstack/sage, @wrongstack/sdd, @wrongstack/worktree |
| @wrongstack/goal | 23 | 24 | @wrongstack/contracts, @wrongstack/core, @wrongstack/worktree |
| @wrongstack/governance | 45 | 37 | @wrongstack/persistence |
| @wrongstack/hq | 72 | 50 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/hq-next | 190 | 66 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/hq, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/kanban | 108 | 88 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 6 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 7 | 11 | @wrongstack/coordination, @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 74 | 98 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/persistence | 10 | 23 | — |
| @wrongstack/plug-lsp | 52 | 57 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 12 | 10 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 152 | 133 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 25 | 20 | — |
| @wrongstack/project-surfaces | 240 | 0 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/providers |
| @wrongstack/providers | 138 | 122 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/requirement-intake | 18 | 20 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 6 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 36 | 39 | @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/governance, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol |
| @wrongstack/sage | 170 | 173 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/hq, @wrongstack/persistence, @wrongstack/primitives, @wrongstack/wrongmemory-client |
| @wrongstack/sage-mcp | 7 | 7 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 42 | @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake, @wrongstack/worktree |
| @wrongstack/security-scanner | 21 | 34 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/techstack | 55 | 65 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 28 | 43 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/tools | 396 | 377 | @wrongstack/agent-catalog, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 497 | 431 | @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 28 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/vibeui | 69 | 24 | @wrongstack/webui-protocol |
| @wrongstack/webui | 781 | 516 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/project-surfaces, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-protocol | 29 | 15 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq |
| @wrongstack/webui-server | 330 | 368 | @wrongstack/agent-catalog, @wrongstack/builtin-plugins, @wrongstack/chronicle, @wrongstack/contracts, @wrongstack/coordination, @wrongstack/core, @wrongstack/fleet, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/worktree, @wrongstack/wrongtrace |
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
| 2010 | `apps/desktop-v2/src/FileWorkspace.tsx` |
| 1696 | `packages/sage/src/wrongmemory-port.ts` |
| 1581 | `apps/desktop-v2/src/ProjectAgentRoster.tsx` |
| 1206 | `packages/vibeui/src/components/workspace.tsx` |
| 1098 | `packages/project-surfaces/src/atlas/codemap-model.ts` |
| 1065 | `apps/desktop-v2/src/ProjectGoals.tsx` |
| 1055 | `apps/desktop-v2/src/SessionComposer.tsx` |
| 951 | `apps/desktop-v2/src/ProjectRequirements.tsx` |
| 931 | `apps/desktop-v2/src/ModelCatalogSettings.tsx` |
| 903 | `apps/desktop-v2/src/SkillLibrary.tsx` |
| 903 | `packages/tools/src/codebase-index/infra-parser.ts` |
| 850 | `apps/desktop-v2/src/AutomationWorkspace.tsx` |
| 815 | `packages/vibeui/src/lib/session.ts` |
| 812 | `apps/desktop-v2/src/ProjectMailbox.tsx` |
| 800 | `packages/vibeui/src/components/resource-hub.tsx` |
| 788 | `apps/desktop-v2/src/ProjectDesignStudio.tsx` |
| 779 | `apps/desktop-v2/src/ProjectChimera.tsx` |
| 779 | `apps/desktop-v2/src/RosterRuntimeEditor.tsx` |
| 777 | `packages/webui-server/src/server/memory-handlers.ts` |
| 766 | `apps/desktop-v2/src/ProjectSdd.tsx` |
| 756 | `packages/fleet/src/host-skill-companion.ts` |
| 754 | `packages/client/src/client.ts` |
| 750 | `packages/vibeui/src/lib/use-session.ts` |
| 748 | `packages/coordination/src/sqlite-mailbox.ts` |
| 740 | `apps/desktop-v2/src/ProjectSessionHistory.tsx` |
| 737 | `packages/webui-server/src/server/completion-handlers.ts` |
| 733 | `apps/desktop-v2/src/ProjectChronicle.tsx` |
| 733 | `packages/vibeui/src/components/provider-manager.tsx` |
| 729 | `packages/tools/src/process-registry.ts` |
| 726 | `packages/coordination/src/multi-agent-coordinator.ts` |
| 724 | `packages/coordination/src/agent-monitor.ts` |
| 720 | `packages/tools/src/read.ts` |
| 718 | `packages/project-surfaces/src/sage/useMemoryManagerState.ts` |
| 715 | `packages/plugins/src/audit/index.ts` |
| 714 | `packages/tui/src/reducers/panel-pickers.ts` |
| 712 | `packages/webui-server/src/server/pref-helpers.ts` |
| 709 | `packages/core/src/storage/file-session-writer.ts` |
| 709 | `packages/vibeui/src/components/memory-browser.tsx` |
| 708 | `packages/core/src/core/agent-tools.ts` |
| 707 | `packages/acp/src/client/acp-session.ts` |
| 707 | `packages/mailbox-mcp/src/adapter.ts` |
| 706 | `packages/chronicle/src/project-server.ts` |
| 705 | `packages/chronicle/src/project-server-client.ts` |
| 705 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 703 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 703 | `packages/tools/src/codebase-index/ast-symbol-mutator.ts` |
| 703 | `packages/tui/src/reducers/settings-value-cycle.ts` |
| 701 | `packages/coordination/src/provider-status-tracker.ts` |
| 700 | `apps/desktop-v2/src/useDesktop.ts` |
| 700 | `packages/coordination/src/fleet-manager.ts` |

## Exports only tests reference

- 1040 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 237 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
