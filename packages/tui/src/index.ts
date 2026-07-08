export { runTui } from './run-tui.js';
export type { RunTuiOptions } from './run-tui.js';
export { buildGoalPreamble } from './app.js';
export type { Settings } from './app.js';
export type { PluginPickerItem } from './components/plugin-picker.js';
export type {
  AuthCatalogRow,
  AuthFlowIo,
  AuthFlowResult,
  AuthKeyRow,
  AuthLocalPresetRow,
  AuthOAuthKind,
  AuthPanelHost,
  AuthProviderRow,
} from './components/auth-panel-model.js';
export { parseInline } from './markdown.js';
export { replaySessionEvents } from './components/history/replay.js';
// parseNextSteps now lives in @wrongstack/tools/next-steps (shared with WebUI and CLI).
// Re-exported here for back-compat with downstream consumers; will be removed in the next minor.
export { parseNextSteps } from './components/suggestions.js';
export type { ParsedNextStep, ParseNextStepsResult } from './components/suggestions.js';
