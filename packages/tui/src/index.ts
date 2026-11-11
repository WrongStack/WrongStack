export type { Settings } from './app.js';
export { buildGoalPreamble } from './app.js';
export type {
  AuthCatalogRow,
  AuthFlowIo,
  AuthFlowResult,
  AuthKeyEdit,
  AuthKeyRow,
  AuthLocalPresetRow,
  AuthModelEdit,
  AuthOAuthKind,
  AuthOAuthStrategyRow,
  AuthPanelHost,
  AuthProviderEdit,
  AuthProviderRow,
  AuthProviderSetup,
} from './auth-panel-model.js';
export type {
  BrainDenyIsTerminal,
  BrainHeuristicKey,
  BrainPanelHeuristics,
  BrainPanelHost,
  BrainPanelPersona,
  BrainPanelSettings,
  BrainPanelVoter,
  BrainTerminalPolicyValue,
  BrainTraceContent,
} from './brain-panel-model.js';
// `replaySessionEvents` is intentionally NOT re-exported — it cannot rebuild a
// session written through the exact message journal, and sitting next to the
// canonical renderer in the barrel made it easy to reach for by mistake.
export { replaySessionMessages } from './components/history/replay.js';
export {
  ImagePreviewModal,
  type ImagePreviewModalProps,
} from './components/image-preview-modal.js';
export type { ProviderOption } from './components/model-picker.js';
export {
  PluginPanelOverlay,
  type PluginPanelOverlayProps,
  PluginStatusStrip,
  type PluginStatusStripProps,
  PluginViewNodeView,
  type PluginViewNodeViewProps,
} from './components/plugin-panel-overlay.js';
export type { PluginPickerItem } from './components/plugin-picker.js';
export {
  PluginPromptModal,
  type PluginPromptModalProps,
} from './components/plugin-prompt-modal.js';
export {
  flattenSessionTreeRows,
  SessionTreeOverlay,
  type SessionTreeOverlayProps,
  type SessionTreeOverlayRow,
} from './components/session-tree-overlay.js';
export type { ParsedNextStep, ParseNextStepsResult } from './components/suggestions.js';
// parseNextSteps now lives in @wrongstack/tools/next-steps (shared with WebUI and CLI).
// Re-exported here for back-compat with downstream consumers; will be removed in the next minor.
export { parseNextSteps } from './components/suggestions.js';
export {
  buildHalfBlockGrid,
  computeImageCellBox,
  decodePngToRgbaThumbnail,
  encodeIterm2Graphics,
  encodeKittyGraphics,
  type HalfBlockCell,
  type ImageCellBox,
  type ImageFormat,
  type ImageHeaderInfo,
  inspectImageHeader,
  KITTY_BASE64_CHUNK_SIZE,
  MAX_TUI_IMAGE_INPUT_BYTES,
} from './graphics/image-codec.js';
export {
  type CachedImagePreview,
  clearImagePreviewCache,
  encodeNativeTerminalImage,
  extractToolImageArtifactPath,
  getImagePreviewCacheSize,
  loadCachedImagePreview,
  MAX_IMAGE_PREVIEW_CACHE_ENTRIES,
} from './graphics/image-preview-cache.js';
export { parseInline } from './markdown.js';
export type { RunTuiOptions } from './run-tui.js';
export { runTui } from './run-tui.js';
export type {
  SubagentLaneTarget,
  SubagentModelsPanelHost,
  SubagentModelsSnapshot,
} from './subagent-models-panel-model.js';
export {
  createSynchronizedStdout,
  DEFAULT_SYNC_STDOUT_MAX_BATCH_BYTES,
  type SynchronizedStdoutHandle,
  type SynchronizedStdoutOptions,
  stripTerminalGraphicsResponses,
} from './sync-stdout.js';
export type {
  ResourceMenuAction,
  ResourceMenuDetail,
  ResourceMenuId,
  ResourceMenuItem,
  ResourceMenuSnapshot,
} from './ui-contracts.js';
