# Architecture Health Report

**Generated:** 2026-10-10T12:51:17.427Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 37 |
| Production source files | 4916 |
| Production source lines | 1090709 |
| Test files | 4269 |
| Workspace dependency edges | 133 |
| Relative module edges | 16187 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 5 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 4 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 48 | 54 | @wrongstack/core, @wrongstack/primitives |
| @wrongstack/bench | 29 | 56 | @wrongstack/core |
| @wrongstack/cli | 617 | 613 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sage-mcp, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/client | 6 | 1 | @wrongstack/webui-protocol |
| @wrongstack/codebase-index-mcp | 5 | 5 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 1111 | 948 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 45 | 30 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 45 | 33 | @wrongstack/persistence |
| @wrongstack/kanban | 105 | 82 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 6 | 8 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 63 | 72 | @wrongstack/core |
| @wrongstack/persistence | 9 | 20 | — |
| @wrongstack/plug-lsp | 52 | 52 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 10 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 149 | 126 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 11 | 12 | — |
| @wrongstack/providers | 130 | 113 | @wrongstack/core |
| @wrongstack/requirement-intake | 17 | 11 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 28 | 24 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol |
| @wrongstack/sage | 146 | 129 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 7 | 6 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 45 | 41 | @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 21 | 31 | @wrongstack/core |
| @wrongstack/simpleui | 127 | 93 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 53 | 51 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 41 | @wrongstack/core, @wrongstack/primitives |
| @wrongstack/tools | 321 | 311 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 479 | 421 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 18 | 28 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 718 | 478 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-hq | 124 | 55 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 25 | 13 | @wrongstack/core |
| @wrongstack/webui-server | 296 | 283 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 11 | 9 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-auto-optimize.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop-context.ts ↔ packages/core/src/core/agent-loop-detector.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/session-note-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/types/blocks.ts ↔ packages/core/src/types/context.ts ↔ packages/core/src/types/conversation-state.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/run-env.ts ↔ packages/core/src/types/session-events.ts ↔ packages/core/src/types/session-storage.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts

## Largest production files

| Lines | File |
|---:|---|
| 796 | `packages/webui/src/components/ProviderTestView.tsx` |
| 774 | `packages/core/src/session-catalog/session-registry.ts` |
| 767 | `packages/plugin-sdk/src/runtime/index.ts` |
| 767 | `packages/webui-server/src/server/session-handlers.ts` |
| 766 | `packages/tools/src/todo.ts` |
| 766 | `packages/webui/src/components/MessageBubble/index.tsx` |
| 764 | `packages/cli/src/subcommands/handlers/hq.ts` |
| 763 | `packages/tools/src/codebase-index/toolchain-scripts.ts` |
| 762 | `packages/core/src/coordination/fleet-manager.ts` |
| 762 | `packages/core/src/plugin/api.ts` |
| 762 | `packages/tui/src/run-tui-options.ts` |
| 761 | `packages/cli/src/plugin-management.ts` |
| 761 | `packages/cli/src/slash-commands/project.ts` |
| 761 | `packages/techstack/src/policy/rulebook.ts` |
| 761 | `packages/tui/src/input-validation.ts` |
| 761 | `packages/tui/src/submit-controller.ts` |
| 759 | `packages/core/src/coordination/sqlite-mailbox.ts` |
| 758 | `packages/core/src/registry/tool-registry.ts` |
| 758 | `packages/tui/src/hooks/use-provider-event-bridge.ts` |
| 757 | `packages/techstack/src/adapters/npm.ts` |
| 757 | `packages/tui/src/components/sidebar-panels-task.tsx` |
| 757 | `packages/webui/src/components/ChimeraReviewsView.tsx` |
| 756 | `packages/tools/src/codebase-index/skeleton-extractor.ts` |
| 755 | `packages/kanban/src/verification/verification-context.ts` |
| 755 | `packages/webui-hq/src/domain/fleet-topology.ts` |
| 754 | `packages/cli/src/execution.ts` |
| 754 | `packages/providers/src/codex-websocket.ts` |
| 753 | `packages/tools/src/session-kanban.ts` |
| 753 | `packages/webui/src/components/DebugDashboard.tsx` |
| 752 | `packages/cli/src/config-doctor.ts` |
| 752 | `packages/kanban/src/storage.ts` |
| 752 | `packages/tui/src/components/context-panel-sections.tsx` |
| 751 | `packages/tui/src/components/sidebar-content.tsx` |
| 751 | `packages/webui/src/components/ChatView/CouncilDecisionCard.tsx` |
| 749 | `packages/providers/src/openai-codex.ts` |
| 748 | `packages/cli/src/boot/tui-session-resume.ts` |
| 748 | `packages/tools/src/process-registry-persistent.ts` |
| 747 | `packages/core/src/core/fallback-model.ts` |
| 747 | `packages/tools/src/bash-stream.ts` |
| 747 | `packages/webui/src/components/SddWizard.tsx` |
| 746 | `packages/core/src/core/agent-response.ts` |
| 746 | `packages/core/src/core/fallback-profile-manager.ts` |
| 746 | `packages/webui-server/src/server/backend-services.ts` |
| 744 | `packages/core/src/utils/tool-output-renderers.ts` |
| 744 | `packages/tools/src/grep.ts` |
| 742 | `packages/core/src/utils/context-evidence.ts` |
| 742 | `packages/tui/src/components/agents-monitor.tsx` |
| 741 | `packages/webui/src/components/TaskActivityTimeline.tsx` |
| 740 | `packages/tui/src/hooks/use-picker-keys-tools-settings.ts` |
| 740 | `packages/webui/src/hooks/ws-handlers/session-replay-handlers.ts` |

## Exports only tests reference

- 961 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 4 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
