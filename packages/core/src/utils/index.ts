export * from './assert-never.js';
export * from './atomic-write.js';
export { deriveCachePrefixKey } from './cache-key.js';
export * from './child-env.js';
export * from './color.js';
export * from './config-backup.js';
export * from './config-json.js';
export { checkConnectivity, resetConnectivityCache } from './connectivity.js';
export { type ContextBreakdown, getContextBreakdown } from './context-breakdown.js';
export {
  addFatalSalvageHook,
  runFatalSalvageSync,
  type CrashShieldOptions,
  installCrashShield,
} from './crash-shield.js';
export {
  buildCompletedWorkLedgerBlock,
  buildContextEvidenceDigest,
  COMPLETED_WORK_LEDGER_MARKER,
  createContextEvidenceState,
  formatCompletedWorkLedger,
  markAssistantReferencedEvidence,
  type RecordCompletedWorkInput,
  type RecordToolOutputEvidenceInput,
  recordCompletedWorkEvidence,
  recordToolOutputEvidence,
  recordUserIntentEvidence,
  repeatedReadPressure,
  syncCompletedWorkLedgerBlock,
} from './context-evidence.js';
export {
  type DeepMergeOptions,
  deepMerge,
  FORBIDDEN_PROTO_KEYS,
  isPrimitiveArray,
} from './deep-merge.js';
export * from './diff.js';
export type { HttpDispatcher, HttpsAgentAsDispatcher } from './dispatcher-types.js';
export * from './env-typed.js';
export { toErrorMessage } from './error.js';
export * from './expect-defined.js';
export { expandGlob } from './glob-expand.js';
export * from './glob-match.js';
export {
  defaultHeapLogPath,
  type HeapDiagnosticFields,
  type HeapDiagnosticValue,
  type HeapSample,
  type HeapWatchdogOptions,
  startHeapWatchdog,
  startSharedHeapWatchdog,
  takeHeapSample,
} from './heap-watchdog.js';
export {
  ALLOWED_IMAGE_MEDIA_TYPES,
  base64DecodedBytes,
  buildUserContentBlocks,
  IncomingImageError,
  type IncomingImagePayload,
  isAllowedImageMediaType,
  isValidImageBase64,
  MAX_INCOMING_IMAGE_BYTES,
  MAX_INCOMING_IMAGES,
  parseIncomingImages,
} from './incoming-images.js';
export { readBundledInstructionText, renderInstructionTemplate } from './instruction-file.js';
export { assertNotPrivateHost, expandIPv6, isPrivateIPv4, isPrivateIPv6 } from './ip-guard.js';
export { completePartialObject } from './json-repair.js';
export {
  type CoercionResult,
  coerceAgainstSchema,
  type ValidationError,
  type ValidationResult,
  validateAgainstSchema,
} from './json-schema-validate.js';
export { mergeCustomModelDefs } from './merge-custom-models.js';
export { mergeModelsPayload } from './merge-models-payload.js';
export {
  formatMemoryEvidenceBlock,
  MEMORY_EVIDENCE_TAG,
  sanitizeMemoryEvidenceBody,
  sanitizeMemoryEvidenceSource,
} from './memory-evidence-fence.js';
export {
  hasMeaningfulContent,
  type MessageRepairReport,
  type MessageRepairResult,
  repairToolUseAdjacency,
} from './message-invariants.js';
export * from './newline-normalize.js';
export {
  isSafePathSegment,
  MAX_PATH_SEGMENT_LENGTH,
  resolveContainedPath,
} from './path-segment.js';
export {
  getPerfProfile,
  indexParallelBatchSize,
  isFrugalPerf,
  type PerfProfile,
  SageCachePragmas,
  sqliteCachePragmas,
  tuiStreamFlushMs,
  useDaemonPerfDefaults,
} from './perf-profile.js';
export { isPidAlive } from './pid.js';
export * from './project-identity.js';
export {
  activateProjectStateGuard,
  type ProjectStateGuard,
  type ProjectStateGuardOptions,
  startProjectStateGuard,
} from './project-state-guard.js';
export {
  type ProjectWatchEvent,
  type ProjectWatchSubscription,
  watchProjectTree,
} from './project-watch.js';
export {
  capSubject,
  type CompileFail,
  type CompileResult,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from './regex-guard.js';
export * from './safe-json.js';
export { sessionScopedPath } from './session-scoped-path.js';
export * from './sleep.js';
export { slugify } from './slug.js';
export * from './socket-path.js';
export { withSqliteExperimentalWarningSuppressed } from './sqlite-warning.js';
export * from './string.js';
export * from './task-format.js';
export {
  buildSgrSequence,
  buildTitleSequence,
  type ColorDepth,
  detectTerminal,
  ESCAPE_TERMINATOR,
  type EscapeEmitResult,
  type EscapeSequence,
  isStdinTTY,
  type MouseProtocol,
  onResize,
  safeEmit,
  setOutputLineGuard,
  setRawMode,
  setTitle,
  type TerminalCapability,
  TerminalLifecycle,
  writeErr,
  writeOut,
} from './term.js';
export { sanitizeTerminalPreview, sanitizeTerminalText } from './terminal-sanitize.js';
export * from './todos-format.js';
export {
  computeMessageTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  estimateTextTokens,
  estimateToolDefTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
  getCalibrationState,
  type RequestTokenBreakdown,
  recordActualUsage,
  resetCalibration,
} from './token-estimate.js';
export {
  applyToolDescriptionModes,
  applyToolDescriptionModeToTool,
  DEFAULT_TOOL_DESCRIPTION_MODE,
  getToolDescriptionMode,
  normalizeToolDescriptionMode,
  resolveToolDescriptionMode,
  setToolDescriptionMode,
  simplifyToolDescription,
  type ToolDescriptionRegistryLike,
} from './tool-description-mode.js';
export {
  mcpQualifiedToolName,
  mcpServerToolPrefix,
  sanitizeWireToolName,
  WIRE_TOOL_NAME_MAX_LENGTH,
  WIRE_TOOL_NAME_PATTERN,
} from './tool-name.js';
export {
  createToolOutputSerializer,
  type ToolOutputSerializerOptions,
} from './tool-output-serializer.js';
export {
  applyToolResultRenderModes,
  DEFAULT_TOOL_RESULT_RENDER_MODE,
  getToolResultRenderMode,
  normalizeToolResultRenderMode,
  resolveToolResultRenderMode,
  setToolResultRenderMode,
  type ToolResultRenderModeRegistryLike,
} from './tool-result-render-mode.js';
export * from './tool-subject.js';
export {
  type CompactToolDefinitionForWireOptions,
  type CompactWireToolDefinition,
  compactSchemaDescriptions,
  compactToolDefinitionForWire,
  normalizeTopLevelToolSchema,
  type ToolWireDefinitionLike,
} from './tool-wire-compact.js';
export { isUlid, ulid } from './ulid.js';
export { DEFAULT_WALK_IGNORE_DIRS, DEFAULT_WALK_IGNORE_SET } from './walk-ignore.js';
export { buildWin32CmdShimInvocation, type Win32CmdShimInvocation } from './win32-cmd.js';
export * from './wstack-paths.js';
export {
  capSageLines,
  SAGE_INJECTOR_HEADINGS,
  splitSageOutputBlock,
  type SageOutputSplit,
} from './sage-output-block.js';
