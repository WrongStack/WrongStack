export { markUserInputObserver, userInputObserverCount } from '../hooks/user-input-observers.js';
export {
  providerToolsForVariant,
  SCOUT_DIRECT_TOOL_NAMES,
} from '../registry/scout-tool-surface.js';
export {
  isToolReachable,
  reachableTools,
  reachesCatalog,
} from '../registry/session-tool-reach.js';
export {
  Agent,
  type RunResult,
  type UserInputPayload,
} from './agent.js';
export {
  AGENT_COORDINATION,
  type AgentCoordinationPort,
  ARCHITECTURE_DECISION_CONTEXT,
  CHIMERA_REPORT_SESSION_RESOLVER,
  CHRONICLE_FILE_LINEAGE,
  HQ_MAILBOX_PUBLISHER_FACTORY,
  resolveAgentCoordination,
  resolveArchitectureDecisionContext,
  resolveChimeraReportSessionResolver,
  resolveChronicleFileLineage,
  resolveHqMailboxPublisherFactory,
} from './agent-coordination.js';
export type { AgentInternals } from './agent-internals.js';
export { keepsOwnContext } from './agent-owned-context.js';
export {
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  createDefaultPipelines,
  installPipelineErrorBoundaries,
  type ToolCallPipelinePayload,
} from './agent-types.js';
export {
  buildBtwBlock,
  consumeBtwNotes,
  pendingBtwCount,
  setBtwNote,
} from './btw.js';
export {
  confirmObserverCount,
  markConfirmObserver,
  resetConfirmObserversForTest,
} from './confirm-observers.js';
export {
  Context,
  type ContextInit,
  type ProviderMemoryEvidence,
  type RunOptions,
  type TodoItem,
} from './context.js';
export { type ContextBreakdown, getContextBreakdown } from './context-breakdown.js';
export { resolveOwningSessionId } from './context-session-id.js';
export {
  type ContinuationInput,
  type ContinuationSource,
  detectContinueIntent,
  type ResolvedContinuation,
  resolveContinuation,
} from './continue-intent.js';
export {
  ConversationState,
  type ReadonlyConversationState,
  type StateChange,
  type StateChangeHandler,
  wrapAsState,
} from './conversation-state.js';
export {
  diagnoseFallbackConfig,
  type FallbackDiagnosticReport,
  type FallbackDiagnosticWarning,
  type FallbackSimulationResult,
  type FallbackSimulationStep,
  simulateFallbackFailover,
} from './fallback-doctor.js';
export {
  createFallbackModelExtension,
  effectiveFallbackChain,
  type FallbackGateFn,
  type FallbackModelDeps,
  fallbackProfileChain,
  runtimeFallbackChain,
  smartDefaultFallbackChain,
} from './fallback-model.js';
export { FallbackProfileManager } from './fallback-profile-manager.js';
export {
  buildFleetPulseBlock,
  fleetPulseSignature,
} from './fleet-pulse.js';
export {
  InputBuilder,
  type InputBuilderEvent,
  type InputBuilderOptions,
} from './input-builder.js';
export {
  type InstructionBundle,
  type InstructionBundlePaths,
  loadInstructionBundle,
  type SystemInstructionVariant,
} from './instruction-bundle.js';
export {
  type InstructionTemplateContext,
  renderInstructionLayer,
} from './instruction-template.js';
export {
  buildMailboxBtwAwarenessBlock,
  createMailboxChecker,
} from './mailbox-loop.js';
export {
  formatModelRef,
  type ModelRef,
  normalizeModelRef,
  parseModelRef,
} from './model-ref.js';
export {
  clearPendingNextSteps,
  hasNextStepsTag,
  MAX_PENDING_NEXT_STEPS,
  maybeAppendPendingNextSteps,
  type PendingNextStep,
  readPendingNextSteps,
  renderNextStepsBlock,
  writePendingNextSteps,
} from './next-steps-slot.js';
export {
  readUserInstructions,
  type UserInstructionsDocument,
  userInstructionsFile,
  writeUserInstructions,
} from './project-instructions.js';
export { runProviderWithRetry } from './provider-runner.js';
export { setQueuedMessagesSnapshot } from './queued-messages.js';
export { isSealedAgent, SEALED_AGENT_META_KEY, sealedSubagentRefusal } from './sealed-agent.js';
export {
  buildSessionNoteBlock,
  consumeSessionNotes,
  enqueueSessionNote,
  pendingSessionNoteCount,
  type SessionNote,
  type SessionNoteKind,
} from './session-notes.js';
export {
  // Exported so surfaces that need to *predict* the identity block (e.g. the
  // CLI's startup system-prompt menu, which shows a per-variant token count)
  // compose it exactly the way the builder does instead of re-implementing the
  // WS-016 project-append rule and drifting from it.
  buildIdentityLayer,
  DefaultSystemPromptBuilder,
  type DefaultSystemPromptBuilderOptions,
  type SystemBlockSource,
} from './system-prompt-builder.js';
export {
  type DomainGlossaryOptions,
  renderDomainGlossary,
} from './system-prompt-glossary.js';
export {
  activateSystemPromptPreset,
  activeSystemPromptPresetText,
  bundledPromptText,
  createSystemPromptPreset,
  deleteSystemPromptPreset,
  listSystemPromptPresets,
  type PromptValidationIssue,
  promptTextHash,
  readActiveSystemPromptPresets,
  readProjectSystemPromptPresets,
  readSystemPromptPreset,
  type SystemPromptPreset,
  saveSystemPromptPreset,
  validateSystemPromptPreset,
} from './system-prompt-presets.js';
export { fenceIfUntrusted, isSkillHiddenFromPrompt } from './system-prompt-skill-bodies.js';
export { capSkillBody } from './system-prompt-skill-text.js';
export {
  countSystemPromptTokens,
  isSystemInstructionVariant,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  SYSTEM_PROMPT_VARIANT_OPTIONS,
  SYSTEM_PROMPT_VARIANTS,
  type SystemPromptVariantPaths,
  systemPromptVariantLabel,
} from './system-prompt-variants.js';
export {
  createEventUserInputAwaiter,
  type EventUserInputAwaiterOptions,
  isUnattendedAutonomy,
} from './user-input-awaiter.js';
