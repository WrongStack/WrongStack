# Architecture Health Report

**Generated:** 2026-10-24T09:09:09.321Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 41 |
| Production source files | 5283 |
| Production source lines | 1150793 |
| Test files | 4651 |
| Workspace dependency edges | 184 |
| Relative module edges | 16020 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 3 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- packages/vibeui/src/components/workspace.tsx: hotspot grew from 1100 to 1103 lines; review and update the ratchet in the same change
- packages/vibeui/src/components/workspace.tsx: relative import fan-out increased from 27 to 29; review and update the ratchet in the same change

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 54 | 60 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/bench | 29 | 56 | @wrongstack/core |
| @wrongstack/cli | 676 | 669 | @wrongstack/acp, @wrongstack/bench, @wrongstack/codebase-index-mcp, @wrongstack/contracts, @wrongstack/core, @wrongstack/desktop, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/kanban-mcp, @wrongstack/mailbox-mcp, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/requirement-intake-mcp, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/vibeui, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/client | 7 | 3 | @wrongstack/webui-protocol |
| @wrongstack/codebase-index-mcp | 6 | 5 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/contracts | 123 | 2 | @wrongstack/kanban, @wrongstack/primitives |
| @wrongstack/core | 954 | 940 | @wrongstack/contracts, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 48 | 35 | @wrongstack/contracts, @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/goal | 22 | 22 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/governance | 45 | 37 | @wrongstack/persistence |
| @wrongstack/hq | 62 | 42 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban | 109 | 84 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 6 | 5 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 7 | 8 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 74 | 97 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/persistence | 9 | 23 | — |
| @wrongstack/plug-lsp | 52 | 57 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 12 | 10 | @wrongstack/contracts, @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 152 | 127 | @wrongstack/contracts, @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 22 | 17 | — |
| @wrongstack/providers | 138 | 121 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/requirement-intake | 18 | 20 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 6 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 35 | 34 | @wrongstack/contracts, @wrongstack/core, @wrongstack/governance, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol |
| @wrongstack/sage | 151 | 156 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 7 | 6 | @wrongstack/contracts, @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 42 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 21 | 34 | @wrongstack/contracts, @wrongstack/core |
| @wrongstack/simpleui | 131 | 101 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 55 | 65 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 28 | 43 | @wrongstack/contracts, @wrongstack/core, @wrongstack/primitives |
| @wrongstack/tools | 373 | 363 | @wrongstack/contracts, @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 496 | 429 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 28 | @wrongstack/contracts, @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/vibeui | 55 | 14 | @wrongstack/webui-protocol |
| @wrongstack/webui | 765 | 506 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-hq | 127 | 55 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 29 | 15 | @wrongstack/contracts, @wrongstack/core, @wrongstack/hq |
| @wrongstack/webui-server | 304 | 307 | @wrongstack/contracts, @wrongstack/core, @wrongstack/goal, @wrongstack/hq, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 11 | 9 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/contracts/src/kernel/events.ts ↔ packages/contracts/src/kernel/events/brain-events.ts ↔ packages/contracts/src/kernel/events/session-events.ts
- packages/contracts/src/types/blocks.ts ↔ packages/contracts/src/types/context.ts ↔ packages/contracts/src/types/conversation-state.ts ↔ packages/contracts/src/types/messages.ts ↔ packages/contracts/src/types/provider.ts ↔ packages/contracts/src/types/run-env.ts ↔ packages/contracts/src/types/session-events.ts ↔ packages/contracts/src/types/session-storage.ts ↔ packages/contracts/src/types/session.ts ↔ packages/contracts/src/types/token-counter.ts ↔ packages/contracts/src/types/tool.ts

## Largest production files

| Lines | File |
|---:|---|
| 1103 | `packages/vibeui/src/components/workspace.tsx` |
| 1098 | `packages/webui/src/components/codemap-model.ts` |
| 911 | `packages/vibeui/src/lib/session.ts` |
| 889 | `packages/tools/src/codebase-index/infra-parser.ts` |
| 754 | `packages/cli/src/fleet/host-skill-companion.ts` |
| 734 | `apps/desktop/src/main/main.ts` |
| 733 | `packages/vibeui/src/components/provider-manager.tsx` |
| 725 | `packages/core/src/coordination/multi-agent-coordinator.ts` |
| 720 | `packages/webui/src/components/MemoryManager/useMemoryManagerState.ts` |
| 715 | `packages/core/src/coordination/agent-monitor.ts` |
| 715 | `packages/plugins/src/audit/index.ts` |
| 708 | `packages/vibeui/src/lib/use-session.ts` |
| 707 | `packages/acp/src/client/acp-session.ts` |
| 705 | `packages/core/src/chronicle/project-server-client.ts` |
| 705 | `packages/webui-server/src/server/memory-handlers.ts` |
| 703 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 700 | `packages/core/src/chronicle/project-server.ts` |
| 699 | `packages/core/src/coordination/subagent-budget.ts` |
| 699 | `packages/governance/src/runtime-compatibility.ts` |
| 698 | `packages/core/src/coordination/provider-status-tracker.ts` |
| 697 | `packages/client/src/client.ts` |
| 697 | `packages/core/src/core/agent-response.ts` |
| 696 | `packages/cli/src/boot/tui-session-resume.ts` |
| 696 | `packages/core/src/coordination/autonomous-brain.ts` |
| 696 | `packages/core/src/coordination/fleet-manager.ts` |
| 696 | `packages/core/src/core/agent-tools.ts` |
| 696 | `packages/webui-server/src/server/completion-handlers.ts` |
| 696 | `packages/webui/src/components/KanbanView.tsx` |
| 695 | `packages/core/src/core/agent-loop.ts` |
| 695 | `packages/core/src/registry/tool-registry.ts` |
| 695 | `packages/core/src/storage/config-loader.ts` |
| 694 | `packages/cli/src/slash-commands/fix-classifier.ts` |
| 693 | `packages/core/src/execution/eternal-autonomy.ts` |
| 692 | `packages/simpleui/src/automation-workspace.tsx` |
| 692 | `packages/tools/src/codebase-index/project-server.ts` |
| 692 | `packages/webui/src/components/MailboxPanel.tsx` |
| 691 | `packages/core/src/coordination/mailbox-project-server-client.ts` |
| 691 | `packages/governance/src/event-store.ts` |
| 691 | `packages/plugins/src/template-engine/index.ts` |
| 691 | `packages/sage/src/types.ts` |
| 691 | `packages/tui/src/hooks/use-director-fleet-bridge.ts` |
| 691 | `packages/webui-server/src/server/session-handler-helpers.ts` |
| 691 | `packages/webui/src/components/SettingsPanel/index.tsx` |
| 690 | `packages/cli/src/slash-commands/kanban-task-subcommands.ts` |
| 690 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 690 | `packages/plugins/src/notify-hub/index.ts` |
| 690 | `packages/tui/src/reducers/settings-value-cycle.ts` |
| 689 | `packages/core/src/storage/file-session-writer.ts` |
| 688 | `packages/core/src/coordination/task-auctioneer.ts` |
| 688 | `packages/webui/src/lib/ws-client.ts` |

## Exports only tests reference

- 970 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
