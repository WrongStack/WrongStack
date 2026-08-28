export {
  Agent,
  type RunResult,
  type UserInputPayload,
} from './agent.js';
export {
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  createDefaultPipelines,
  type ToolCallPipelinePayload,
} from './agent-types.js';
export {
  buildBtwBlock,
  consumeBtwNotes,
  pendingBtwCount,
  setBtwNote,
} from './btw.js';
export {
  buildSessionNoteBlock,
  consumeSessionNotes,
  enqueueSessionNote,
  pendingSessionNoteCount,
  type SessionNote,
  type SessionNoteKind,
} from './session-notes.js';
export {
  Context,
  type ContextInit,
  type ProviderMemoryEvidence,
  type RunOptions,
  type TodoItem,
} from './context.js';
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
export { runProviderWithRetry } from './provider-runner.js';
export { setQueuedMessagesSnapshot } from './queued-messages.js';
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
  countSystemPromptTokens,
  isSystemInstructionVariant,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  SYSTEM_PROMPT_VARIANT_OPTIONS,
  SYSTEM_PROMPT_VARIANTS,
  type SystemPromptVariantPaths,
  systemPromptVariantLabel,
} from './system-prompt-variants.js';
