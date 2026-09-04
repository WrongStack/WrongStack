# Architecture Health Report

**Generated:** 2026-09-04T07:05:51.912Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 36 |
| Production source files | 3535 |
| Production source lines | 862119 |
| Test files | 3043 |
| Workspace dependency edges | 127 |
| Relative module edges | 11080 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 10 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- 1 unexcepted module cycle(s)
- packages/cli/src/auth-menu/panel-service.ts: new 1029-line hotspot is not in architecture/hotspots.json
- packages/cli/src/cli-main.ts: hotspot grew from 839 to 851 lines; review and update the ratchet in the same change
- packages/cli/src/execution.ts: hotspot grew from 881 to 887 lines; review and update the ratchet in the same change
- packages/cli/src/webui-server.ts: hotspot grew from 943 to 949 lines; review and update the ratchet in the same change
- packages/core/src/session-catalog/store.ts: hotspot grew from 994 to 1058 lines; review and update the ratchet in the same change
- packages/core/src/session-catalog/store.ts: relative import fan-out increased from 11 to 12; review and update the ratchet in the same change
- packages/core/src/storage/session-store.ts: hotspot grew from 1088 to 1426 lines; review and update the ratchet in the same change
- packages/core/src/storage/session-store.ts: relative import fan-out increased from 38 to 42; review and update the ratchet in the same change
- packages/core/src/types/session.ts: hotspot grew from 947 to 994 lines; review and update the ratchet in the same change
- packages/providers/src/openai-codex.ts: hotspot grew from 819 to 829 lines; review and update the ratchet in the same change
- packages/sage/src/domain-term-extractor.ts: hotspot grew from 872 to 873 lines; review and update the ratchet in the same change
- packages/sage/src/tools/memory-tools.ts: hotspot grew from 977 to 981 lines; review and update the ratchet in the same change
- packages/tui/src/app-state.ts: hotspot grew from 946 to 963 lines; review and update the ratchet in the same change
- packages/tui/src/app.tsx: hotspot grew from 1004 to 1036 lines; review and update the ratchet in the same change
- packages/tui/src/components/status-bar-rails.tsx: hotspot grew from 1011 to 1217 lines; review and update the ratchet in the same change
- packages/tui/src/hooks/use-picker-keys-tools-settings.ts: new 827-line hotspot is not in architecture/hotspots.json
- packages/webui/src/lib/ws-client.ts: hotspot grew from 1343 to 1386 lines; review and update the ratchet in the same change
- packages/webui/src/stores/ui-store.ts: hotspot grew from 1279 to 1290 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/embedded-message-router.ts: hotspot shrunk from 855 to 831 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/embedded-message-router.ts: relative import fan-out decreased from 53 to 52; review and update the ratchet in the same change
- packages/webui-server/src/server/memory-handlers.ts: new 863-line hotspot is not in architecture/hotspots.json
- packages/webui-server/src/server/routes.ts: hotspot shrunk from 964 to 938 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/start-webui.ts: hotspot grew from 1053 to 1092 lines; review and update the ratchet in the same change
- packages/core/src/statusline/index.ts: "DEFAULT_HIDDEN_ITEMS" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/mcp/src/read-body.ts: "MAX_MCP_HTTP_BODY_BYTES" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/tui/src/components/powerline-rail.tsx: "computeRailSpans" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui/src/lib/platform.ts: "ALT_KEY_LABEL" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui/src/lib/platform.ts: "IS_APPLE_PLATFORM" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui/src/lib/platform.ts: "SHIFT_KEY_LABEL" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/tui/src/workbench-slash.ts: "createWorkbenchSlashCommand" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-server/src/server/ws-payload-validation.ts: "validateBrainConfigSetPayload" is no longer test-only; remove it from architecture/test-only-exports.json in the same change

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 42 | 35 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 476 | 453 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 795 | 704 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 37 | 18 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 27 | @wrongstack/persistence |
| @wrongstack/kanban | 87 | 65 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 37 | 33 | @wrongstack/core |
| @wrongstack/persistence | 6 | 6 | — |
| @wrongstack/plug-lsp | 42 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 1 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 83 | 122 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 5 | 4 | — |
| @wrongstack/providers | 59 | 54 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 9 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 13 | 16 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 104 | 80 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 36 | @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 18 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 93 | 61 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 36 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 30 | @wrongstack/core |
| @wrongstack/tools | 191 | 202 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 358 | 329 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 16 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 505 | 355 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-hq | 110 | 31 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 16 | 7 | @wrongstack/core |
| @wrongstack/webui-server | 204 | 186 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 11 | 5 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/index.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-auto-optimize.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop-context.ts ↔ packages/core/src/core/agent-loop-detector.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/session-note-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/hq/protocol/client.ts ↔ packages/core/src/hq/protocol/core.ts ↔ packages/core/src/hq/protocol/fleet.ts ↔ packages/core/src/hq/protocol/session.ts
- packages/core/src/index.ts ↔ packages/core/src/plugins/prompts-plugin.ts ↔ packages/core/src/plugins/skills-plugin.ts ↔ packages/core/src/plugins/sync-plugin.ts ↔ packages/core/src/tools/mcp-control.ts ↔ packages/core/src/tools/mcp-use.ts
- packages/core/src/types/blocks.ts ↔ packages/core/src/types/context.ts ↔ packages/core/src/types/conversation-state.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/run-env.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts
- packages/tui/src/app-settings-type.ts ↔ packages/tui/src/components/settings-picker-model.ts ↔ packages/tui/src/components/settings-picker.tsx ↔ packages/tui/src/components/status-bar-types.ts ↔ packages/tui/src/components/statusline-picker.tsx ↔ packages/tui/src/settings-contracts.ts ↔ packages/tui/src/ui-contracts.ts
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar-rails.tsx ↔ packages/tui/src/components/status-bar.tsx ↔ packages/tui/src/components/status-line-registry.tsx

## Largest production files

| Lines | File |
|---:|---|
| 1715 | `packages/webui-server/src/server/session-handlers.ts` |
| 1426 | `packages/core/src/storage/session-store.ts` |
| 1386 | `packages/webui/src/lib/ws-client.ts` |
| 1309 | `packages/core/src/chronicle/query.ts` |
| 1290 | `packages/webui/src/stores/ui-store.ts` |
| 1217 | `packages/tui/src/components/status-bar-rails.tsx` |
| 1172 | `packages/core/src/coordination/multi-agent-coordinator.ts` |
| 1169 | `packages/webui/src/types/server-message.ts` |
| 1128 | `packages/webui/src/components/ChatInput.tsx` |
| 1110 | `packages/webui/src/stores/viz-store.ts` |
| 1105 | `packages/webui-server/src/server/file-handlers.ts` |
| 1103 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 1095 | `packages/tui/src/components/settings-picker-model.ts` |
| 1092 | `packages/core/src/coordination/provider-status-tracker.ts` |
| 1092 | `packages/webui-server/src/server/start-webui.ts` |
| 1088 | `packages/core/src/core/context.ts` |
| 1081 | `packages/webui/src/components/AgentOfficeView.tsx` |
| 1080 | `packages/tools/src/codebase-index/writer.ts` |
| 1078 | `packages/core/src/storage/file-session-writer.ts` |
| 1068 | `packages/tools/src/codebase-index/project-server.ts` |
| 1062 | `packages/webui/src/components/FileActivityDrawer.tsx` |
| 1058 | `packages/core/src/session-catalog/store.ts` |
| 1056 | `packages/webui-server/src/server/kanban-routes.ts` |
| 1051 | `packages/core/src/coordination/delegate-tool.ts` |
| 1051 | `packages/webui/src/components/SkillDetailView.tsx` |
| 1049 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 1048 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1047 | `packages/core/src/index.ts` |
| 1044 | `packages/webui/src/components/ContextDashboard.tsx` |
| 1041 | `packages/tui/src/components/sidebar-content.tsx` |
| 1039 | `packages/webui-server/src/server/context-editor.ts` |
| 1038 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 1036 | `packages/tui/src/app.tsx` |
| 1036 | `packages/tui/src/components/kanban-panel.tsx` |
| 1033 | `packages/cli/src/plugin-management.ts` |
| 1033 | `packages/sage/src/sqlite-store.ts` |
| 1030 | `packages/plugins/src/git-autocommit/index.ts` |
| 1030 | `packages/tui/src/components/history/utils.tsx` |
| 1029 | `packages/cli/src/auth-menu/panel-service.ts` |
| 1019 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1014 | `packages/cli/src/slash-commands/sdd.ts` |
| 1014 | `packages/tui/src/components/context-panel.tsx` |
| 1013 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1005 | `packages/tui/src/kanban-slash.ts` |
| 1004 | `packages/webui/src/hooks/ws-handlers/misc-handlers.ts` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 1001 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 997 | `packages/mcp/src/client.ts` |
| 996 | `packages/sage/src/types.ts` |
| 996 | `packages/webui/src/stores/fleet-store.ts` |

## Exports only tests reference

- 857 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
