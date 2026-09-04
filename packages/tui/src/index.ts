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
export type { ProviderOption } from './components/model-picker.js';
export type { PluginPickerItem } from './components/plugin-picker.js';
export type { ParsedNextStep, ParseNextStepsResult } from './components/suggestions.js';
// parseNextSteps now lives in @wrongstack/tools/next-steps (shared with WebUI and CLI).
// Re-exported here for back-compat with downstream consumers; will be removed in the next minor.
export { parseNextSteps } from './components/suggestions.js';
export { parseInline } from './markdown.js';
export type { RunTuiOptions } from './run-tui.js';
export { runTui } from './run-tui.js';
export type {
  ResourceMenuAction,
  ResourceMenuDetail,
  ResourceMenuId,
  ResourceMenuItem,
  ResourceMenuSnapshot,
} from './ui-contracts.js';
