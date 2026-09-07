# Codebase Atlas

Generated from the codebase index. Do not edit by hand — run `/codebase-map --write`.

- Indexed files: 8463
- Indexed symbols: 67044
- Packages: 30

Ranking is PageRank over the reference graph (calls, imports, type references,
inheritance). `1.0000` is the most central file in this repository; the scores
are relative to this repository only.

## Packages

| Package | Files | Hub | Rank |
| --- | ---: | --- | ---: |
| @wrongstack/kanban | 161 | `packages/kanban/src/types.ts` | 1.0000 |
| @wrongstack/acp | 87 | `packages/acp/src/types/acp-v1.ts` | 0.8704 |
| @wrongstack/core | 2135 | `packages/core/src/types/provider.ts` | 0.8604 |
| @wrongstack/webui | 965 | `packages/webui/src/lib/ws-client-actions.ts` | 0.7221 |
| @wrongstack/sage | 194 | `packages/sage/src/types.ts` | 0.6853 |
| @wrongstack/tools | 439 | `packages/tools/src/codebase-index/writer.ts` | 0.6748 |
| @wrongstack/mcp | 76 | `packages/mcp/src/client.ts` | 0.5421 |
| @wrongstack/webui-server | 420 | `packages/webui-server/src/server/ws-payload-validation.ts` | 0.5166 |
| @wrongstack/desktop | 65 | `apps/desktop/src/renderer/src/renderer.ts` | 0.4952 |
| @wrongstack/techstack | 90 | `packages/techstack/src/types.ts` | 0.4506 |
| @wrongstack/governance | 71 | `packages/governance/src/capability-grant.ts` | 0.4088 |
| @wrongstack/requirement-intake | 31 | `packages/requirement-intake/src/types.ts` | 0.4035 |
| @wrongstack/telegram | 64 | `packages/telegram/src/api-client.ts` | 0.3701 |
| wrongstack-monorepo | 642 | `scripts/release-check-matrix.mjs` | 0.3161 |
| @wrongstack/bench | 88 | `packages/bench/src/types.ts` | 0.3014 |
| @wrongstack/plugins | 218 | `packages/plugins/src/accessibility-auditor/index.ts` | 0.2943 |
| @wrongstack/cli | 961 | `packages/cli/src/tuneup.ts` | 0.2837 |
| @wrongstack/providers | 118 | `packages/providers/src/openai-codex.ts` | 0.2646 |
| @wrongstack/primitives | 12 | `packages/primitives/src/regex-guard.ts` | 0.2611 |
| @wrongstack/tui | 718 | `packages/tui/src/brain-panel-model.ts` | 0.2402 |
| @wrongstack/webui-hq | 155 | `packages/webui-hq/src/data/transport/hq-socket.ts` | 0.2392 |
| @wrongstack/simpleui | 170 | `packages/simpleui/src/types.ts` | 0.2390 |
| @wrongstack/sdd | 78 | `packages/sdd/src/sdd-board-store.ts` | 0.2191 |
| @wrongstack/security-scanner | 48 | `packages/security-scanner/src/types.ts` | 0.2188 |
| @wrongstack/runtime | 34 | `packages/runtime/src/governance-bootstrap.ts` | 0.2108 |
| @wrongstack/vector-memory | 36 | `packages/vector-memory/src/store.ts` | 0.2008 |
| @wrongstack/wrongtrace | 20 | `packages/wrongtrace/src/types.ts` | 0.1948 |
| @wrongstack/persistence | 18 | `packages/persistence/src/atomic-write.ts` | 0.1894 |
| wrongstack-website | 105 | `website/src/components/site/KanbanLiveDemo.tsx` | 0.1814 |
| @wrongstack/plugin-sdk | 16 | `packages/plugin-sdk/src/runtime/index.ts` | 0.1745 |

## Most central files (top 60 of 300)

The full ranking, with every declaration, is in `atlas.json`.

| Rank | File | In | Out | Declarations |
| ---: | --- | ---: | ---: | --- |
| 1.0000 | `packages/kanban/src/types.ts` | 1715 | 78 | `KanbanTaskPriority`, `KanbanTaskType`, `KanbanTaskStatus` |
| 0.8704 | `packages/acp/src/types/acp-v1.ts` | 341 | 99 | `ACP_PROTOCOL_VERSION`, `ACPProtocolVersion`, `SessionId` |
| 0.8604 | `packages/core/src/types/provider.ts` | 1553 | 85 | `ReasoningEffort`, `REASONING_EFFORT_LEVELS`, `isReasoningEffort` |
| 0.7221 | `packages/webui/src/lib/ws-client-actions.ts` | 99 | 98 | `WsClientActionHost`, `WsClientActionMethods`, `actionMethods` |
| 0.6853 | `packages/sage/src/types.ts` | 600 | 91 | `SAGE_SCHEMA_VERSION`, `SageScope`, `PersistenceClass` |
| 0.6822 | `packages/kanban/src/test-support-session.ts` | 52 | 70 | `TEST_EVENT_CONTEXT`, `WithBoundTail`, `WithBoundOptions` |
| 0.6748 | `packages/tools/src/codebase-index/writer.ts` | 170 | 252 | `DB_FILE`, `MAX_STATEMENT_CACHE`, `IndexStore` |
| 0.6586 | `packages/core/src/types/session.ts` | 784 | 39 | `SessionMetadata`, `SessionEvent`, `SessionEventAttribution` |
| 0.6092 | `packages/kanban/src/server/kanban-store.ts` | 48 | 66 | `DomainModule`, `DomainArgs`, `DomainResult` |
| 0.6021 | `packages/core/src/coordination/knowledge-graph.ts` | 374 | 120 | `NodeType`, `FactCategory`, `GoalStatus` |
| 0.5473 | `packages/core/src/hq/protocol/core.ts` | 99 | 189 | `HqWelcomePayload`, `HqUsagePayload`, `HqMachineRecord` |
| 0.5421 | `packages/mcp/src/client.ts` | 63 | 134 | `Transport`, `MCPClientOptions`, `MCPRequestOptions` |
| 0.5228 | `packages/webui/src/types/server-message.ts` | 0 | 272 | `WSServerMessage` |
| 0.5166 | `packages/webui-server/src/server/ws-payload-validation.ts` | 183 | 130 | `PayloadValidationResult`, `isRecord`, `ModelSwitchPayload` |
| 0.5157 | `packages/core/src/core/context.ts` | 864 | 80 | `RunOptions`, `ContextInit`, `Context` |
| 0.5149 | `packages/webui/src/lib/ws-client-domain-methods.ts` | 87 | 72 | `WsClientDomainHost`, `domainMethods`, `getGitInfo` |
| 0.5146 | `packages/core/src/types/multi-agent.ts` | 735 | 36 | `SubagentSpawnLineage`, `SubagentConfig`, `SubagentErrorKind` |
| 0.5092 | `packages/core/src/coordination/brain.ts` | 432 | 82 | `BrainDecisionSource`, `BrainRisk`, `BRAIN_RISK_LEVELS` |
| 0.4952 | `apps/desktop/src/renderer/src/renderer.ts` | 59 | 217 | `LOCALE_ENDONYMS`, `appRootElement`, `appRoot` |
| 0.4938 | `packages/mcp/src/authorization.ts` | 206 | 167 | `MCPAccessToken`, `MCPAuthorizationContext`, `MCPAuthorizationChallenge` |
| 0.4746 | `packages/tools/src/codebase-index/schema.ts` | 424 | 21 | `SymbolLang`, `SymbolKind`, `Symbol` |
| 0.4506 | `packages/techstack/src/types.ts` | 449 | 16 | `EcosystemId`, `SourceType`, `DependencyScope` |
| 0.4320 | `packages/tools/src/languages/types.ts` | 302 | 42 | `LanguageProfileId`, `LanguageOperation`, `EvidenceKind` |
| 0.4277 | `packages/sage/src/sqlite-store.ts` | 103 | 236 | `isSqliteAvailable`, `SqliteSageStore`, `paths` |
| 0.4127 | `packages/tools/src/codebase-index/background-indexer.ts` | 203 | 199 | `DEFAULT_FULL_INDEX_TIMEOUT_MS`, `DEFAULT_INCREMENTAL_TIMEOUT_MS`, `DEFAULT_QUERY_TIMEOUT_MS` |
| 0.4088 | `packages/governance/src/capability-grant.ts` | 110 | 66 | `DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS`, `DEFAULT_GOVERNANCE_MAX_GRANTS`, `GovernanceCapabilityGrantStatus` |
| 0.4055 | `packages/kanban/src/storage.ts` | 182 | 199 | `KANBANS_DIR`, `BOARD_ID_RE`, `testMetadata` |
| 0.4055 | `packages/governance/src/event-store.ts` | 102 | 134 | `GOVERNANCE_EVENT_STORE_SCHEMA_VERSION`, `EventRow`, `ReceiptRow` |
| 0.4040 | `packages/kanban/src/client-domain.ts` | 1418 | 93 | `DomainModule`, `DomainFunction`, `operationSet` |
| 0.4035 | `packages/requirement-intake/src/types.ts` | 201 | 46 | `IntakeActor`, `IntakeContext`, `IntakeAttachment` |
| 0.3958 | `packages/tools/src/session-kanban.ts` | 165 | 237 | `SESSION_BOARD_TAG`, `MIRROR_DISABLED_ENV`, `SESSION_KANBAN_COLUMNS` |
| 0.3899 | `packages/core/src/storage/session-store.ts` | 83 | 182 | `DefaultSessionStore`, `dir`, `events` |
| 0.3849 | `packages/webui/src/stores/chat-lanes.ts` | 455 | 142 | `MAX_LANES`, `DEFAULT_LANE_ID`, `ChatLaneData` |
| 0.3839 | `apps/desktop/src/main/runtime-manager.ts` | 398 | 237 | `DesktopStateFile`, `DesktopProjectSessionState`, `RuntimeInternal` |
| 0.3838 | `packages/governance/src/daemon-metadata.ts` | 221 | 138 | `GOVERNANCE_DAEMON_METADATA_SCHEMA_VERSION`, `GOVERNANCE_DAEMON_STARTUP_LEASE_SCHEMA_VERSION`, `GOVERNANCE_DAEMON_ATTACHMENT_BROKER_SCHEMA_VERSION` |
| 0.3831 | `packages/core/src/coordination/mailbox-types.ts` | 275 | 60 | `RegisteredAgent`, `MailboxAgentStatus`, `MailboxQuery` |
| 0.3830 | `packages/tools/src/browser/tools.ts` | 65 | 147 | `managers`, `cleanupSignalByContext`, `signalFor` |
| 0.3808 | `packages/core/src/chronicle/journal.ts` | 108 | 133 | `DEFAULT_MAX_PARTITION_BYTES`, `DEFAULT_ROTATION_WINDOW_MS`, `RETENTION_CHECKPOINT_VERSION` |
| 0.3732 | `packages/core/src/types/errors.ts` | 394 | 62 | `ERROR_CODES`, `ErrorCode`, `ErrorSubsystem` |
| 0.3701 | `packages/telegram/src/api-client.ts` | 175 | 65 | `TelegramApiUser`, `TelegramApiChatType`, `TelegramApiChat` |
| 0.3670 | `packages/mcp/src/registry.ts` | 97 | 173 | `MCPRegistry`, `servers`, `disabledServers` |
| 0.3648 | `packages/kanban/src/types-operations.ts` | 261 | 135 | `CreateKanbanBoardInput`, `UpdateKanbanBoardInput`, `DuplicateKanbanBoardInput` |
| 0.3646 | `packages/webui/src/types/protocol-core.ts` | 140 | 37 | `WSSessionStart`, `WSSessionEnd`, `SessionScopedPayload` |
| 0.3592 | `packages/core/src/chronicle/project-server.ts` | 68 | 215 | `DEFAULT_IDLE_MS`, `MAX_APPEND_BATCH`, `MAX_CLIENT_WRITE_BUFFER_BYTES` |
| 0.3591 | `packages/requirement-intake/src/service.ts` | 40 | 194 | `RequirementIntakeServiceOptions`, `IntakeCreateResult`, `IntakeSubmitResult` |
| 0.3445 | `packages/core/src/coordination/director.ts` | 15 | 162 | `BUSY_REARM_FLOOR_MS`, `Director`, `_asManifestEntry` |
| 0.3404 | `packages/core/src/utils/tool-output-serializer.ts` | 73 | 106 | `ToolOutputSerializerOptions`, `ToolOutputSerializeContext`, `RecordValue` |
| 0.3383 | `packages/core/src/execution/prompt-enhancer.ts` | 94 | 122 | `ENHANCER_SYSTEM_PROMPT`, `AFFIRMATION_RE`, `shouldEnhance` |
| 0.3358 | `packages/core/src/coordination/sqlite-mailbox.ts` | 58 | 200 | `SQLITE_MAILBOX_FILE`, `HEARTBEAT_TRACKING_MAX_ENTRIES`, `HEARTBEAT_TRACKING_TTL_MS` |
| 0.3336 | `packages/acp/src/client/acp-session.ts` | 293 | 152 | `PendingRequest`, `State`, `ACPSession` |
| 0.3311 | `packages/requirement-intake/src/constants.ts` | 129 | 1 | `INTAKE_ID_PREFIX`, `ANSWER_ID_PREFIX`, `ATTACHMENT_ID_PREFIX` |
| 0.3300 | `packages/requirement-intake/src/validation.ts` | 56 | 67 | `requestTypeSchema`, `prioritySchema`, `intakeQuestionStatusSchema` |
| 0.3284 | `packages/core/src/execution/auto-compaction-middleware.ts` | 59 | 132 | `PressureLevel`, `LEVEL_RANK`, `pressureLevelFor` |
| 0.3252 | `packages/governance/src/runtime-compatibility.ts` | 83 | 142 | `GOVERNANCE_COMPATIBILITY_ADMIN_TTL_MS`, `GOVERNANCE_COMPATIBILITY_MODEL_TTL_MS`, `GovernanceModelCapability` |
| 0.3179 | `packages/core/src/coordination/task-dag.ts` | 50 | 60 | `DAGNode`, `DAGNodeStatus`, `isTerminalDagStatus` |
| 0.3170 | `packages/core/src/coordination/fleet-bus.ts` | 235 | 37 | `FleetEvent`, `FleetHandler`, `FleetBus` |
| 0.3161 | `scripts/release-check-matrix.mjs` | 1187 | 92 | `LOG_DIRS`, `CACHE_SCHEMA_VERSION`, `CACHEABLE_GATES` |
| 0.3141 | `packages/acp/src/types/acp-messages.ts` | 333 | 9 | `ACPMessage`, `ACPError`, `ACPToolList` |
| 0.3120 | `packages/core/src/wiring/proxy-rewrite.ts` | 160 | 51 | `PROXY_PATH_PREFIX`, `PROXY_EXCLUDED_PROVIDERS`, `isProxyEligible` |
| 0.3107 | `packages/core/src/security/trust-boundary.ts` | 194 | 71 | `TRUST_BOUNDARY_VERSION`, `TrustSurface`, `TrustActorKind` |
