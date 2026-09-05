import type { ReasoningEffort as CoreReasoningEffort } from '@wrongstack/core/types';
import { TOTAL_SETTINGS_FIELD_COUNT } from '../ui-contracts.js';
import { ANIMATION_STYLE_DESCS, ANIMATION_STYLES } from './animation-style.js';

/** Selectable presets for the auto-proceed delay, so the field is fully
 *  keyboard-cyclable (←/→) instead of needing typed numeric input. */
export const DELAY_PRESETS_MS = [0, 15_000, 30_000, 45_000, 60_000, 120_000];
export const SETTINGS_MODES = ['off', 'suggest', 'auto'] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const AUDIT_LEVELS = ['minimal', 'standard', 'full'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export const COMPACTOR_STRATEGIES = ['hybrid', 'intelligent', 'selective'] as const;
export type CompactorStrategy = (typeof COMPACTOR_STRATEGIES)[number];

/** Context window mode options — cyclable via ←/→. */
export const CONTEXT_MODES = ['balanced', 'frugal', 'deep'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_MODE_DESCS: Record<ContextMode, string> = {
  balanced: 'Normal context usage (default)',
  frugal: 'Conservative token use',
  deep: 'Larger context for complex tasks',
};

export const STATUSLINE_MODES = ['minimum', 'detailed', 'no-color'] as const;
export type StatuslineMode = (typeof STATUSLINE_MODES)[number];

export const DEFAULT_STATUSLINE_MODE: StatuslineMode = 'minimum';

export const REASONING_MODES = ['auto', 'on', 'off'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly CoreReasoningEffort[];
export type ReasoningEffort = CoreReasoningEffort;

export const CACHE_TTLS = ['default', '5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const STATUSLINE_MODE_DESCS: Record<StatuslineMode, string> = {
  minimum: 'Single line with essential chips only (default)',
  detailed: 'Full multi-line statusline',
  'no-color': 'Multiline statusline without colors or icons',
};

/** Presets for max iterations — cyclable via ←/→. 0 = unlimited. */
export const MAX_ITERATIONS_PRESETS = [100, 200, 500, 1000, 0];

/** Presets for max concurrent subagents. 0 = runtime default. */
export const MAX_CONCURRENT_PRESETS = [1, 3, 4, 5, 10, 25, 50, 0];

/** Presets for auto-proceed max iterations. 0 = unlimited, 50 default. */
export const AUTO_PROCEED_MAX_PRESETS = [10, 25, 50, 100, 250, 0];

/** Presets for prompt refinement preview countdown. */
export const ENHANCE_DELAY_PRESETS = [15_000, 30_000, 45_000, 60_000, 90_000, 120_000];

/** Presets for pre-refine grace countdown (seconds). 0 = skip. */
export const PRE_REFINE_SECONDS_PRESETS = [0, 2, 3, 5, 8, 10];

/** Presets for the circuit-breaker auto kill/reset delay. 0 = manual recovery. */
export const BREAKER_TIMEOUT_PRESETS = [0, 30_000, 60_000, 120_000, 300_000];

export function formatBreakerTimeout(ms: number): string {
  if (ms === 0) return 'manual';
  return formatSettingsDelay(ms);
}

export const MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS = [3, 5, 8, 10, 15, 0];

/** Language options for prompt refinement. */
export const ENHANCE_LANGUAGES = ['original', 'english'] as const;
export type EnhanceLanguage = (typeof ENHANCE_LANGUAGES)[number];

export const TOKEN_SAVING_TIERS = [
  'auto',
  'off',
  'minimal',
  'light',
  'medium',
  'aggressive',
] as const;
export type TokenSavingTierTui = (typeof TOKEN_SAVING_TIERS)[number];

export const TOKEN_SAVING_TIER_DESCS: Record<TokenSavingTierTui, string> = {
  auto: 'Medium direct surface; prompt adapts to the model window',
  off: 'Every enabled catalog tool is sent directly; full prompt',
  minimal: 'Essential direct tools; compact prompt and guidance',
  light: 'Essential direct tools; retains common workflow guidance',
  medium: 'Essential + regular development tools; moderate trimming',
  aggressive: 'Smallest direct surface and most compact prompt',
};

export const FLEET_CHAT_MODES = ['off', 'full'] as const;
export type FleetChatVerbosityTui = (typeof FLEET_CHAT_MODES)[number];

export const FLEET_CHAT_MODE_DESCS: Record<FleetChatVerbosityTui, string> = {
  off: 'No subagent lines in chat (F2/F3 monitors stay live)',
  full: 'Every subagent tool call and message',
};

export function formatSettingsDelay(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatMaxIterations(n: number): string {
  if (n === 0) return 'unlimited';
  return String(n);
}

export function formatMultiDiffSummaryThreshold(n: number): string {
  if (n === 0) return 'off';
  return String(n);
}

export function formatEnhanceDelay(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function formatPreRefineSeconds(s: number): string {
  if (s === 0) return 'off';
  return `${s}s`;
}

export const ANIMATION_STYLE_CHOICES = [...ANIMATION_STYLES, 'cycle'] as const;
export type AnimationStyleChoice = (typeof ANIMATION_STYLE_CHOICES)[number];

export function formatAnimationStyle(style: AnimationStyleChoice): string {
  if (style === 'cycle') return 'cycle (shuffle all)';
  return ANIMATION_STYLE_DESCS[style];
}

export const MODE_DESC: Record<SettingsMode, string> = {
  off: 'Agent stops after each turn (normal)',
  suggest: 'Shows next-step suggestions after each turn',
  auto: 'Self-driving — agent continues automatically',
};

export const SETTINGS_FIELD_COUNT = TOTAL_SETTINGS_FIELD_COUNT;
export const THINKING_WORD_FIELD = 22;
export const WRONGPROXY_URL_FIELD = 60;
export const MULTI_DIFF_SUMMARY_THRESHOLD_FIELD = 21;

export const THINKING_WORD_PRESETS = [
  'thinking',
  'random',
  'working',
  'cooking',
  'vibing',
  'pondering',
  'brewing',
  'crunching',
  'computing',
  'grinding',
  'noodling',
  'churning',
  'hacking',
] as const;

export const CONFIG_SCOPES = ['global', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const SAGE_THRESHOLD_PRESETS = [0.72, 0.75, 0.85, 0.9, 0.95];

export function formatSageThreshold(t: number): string {
  return t.toFixed(2);
}

/**
 * Human-readable labels for all settings fields (0–SETTINGS_FIELD_COUNT-1),
 * in picker row order.
 */
export const SETTINGS_FIELD_LABELS: readonly string[] = [
  'Default autonomy mode', // 0
  'Auto-proceed delay', // 1
  'Terminal title animation', // 2
  'YOLO mode', // 3
  'Fleet chat', // 4
  'Completion chime', // 5
  'Confirm before exit', // 6
  'Next prediction', // 7
  'MCP features', // 8
  'Plugin features', // 9
  'Memory features', // 10
  'Skills features', // 11
  'Models registry', // 12
  'Token-saving mode', // 13
  'Allow outside project root', // 14
  'Max iterations', // 15
  'Auto-proceed max iterations', // 16
  'Refine preview countdown', // 17
  'Refine', // 18
  'Refine language', // 19
  'Index on session start', // 20
  'Multi-diff summary', // 21
  'Thinking word', // 22
  'Reasoning mode', // 23
  'Reasoning effort', // 24
  'Reasoning preserve', // 25
  'Cache TTL', // 26
  'Context auto-compact', // 27
  'Compactor strategy', // 28
  'Context mode', // 29
  'Max concurrent', // 30
  'Log level', // 31
  'Audit level', // 32
  'Stream debug logging', // 33
  'Statusline', // 34
  'Config scope', // 35
  'Animation', // 36
  'Circuit breaker', // 37
  'Breaker timeout', // 38
  'Show model reasoning', // 39
  'Agent swarm panel', // 40
  'Pre-refine countdown', // 41
  'Read symbols', // 42
  'Show SAGE Memory Inject', // 43
  'SAGE Memory Inject threshold', // 44
  'Nextsteps tool', // 45
  'Project switcher placement', // 46 (P panel id index 0)
  'Fleet placement', // 47 (P panel id index 1)
  'Agents placement', // 48 (P panel id index 2)
  'Worktree placement', // 49 (P panel id index 3)
  'Plan placement', // 50 (P panel id index 4)
  'Todos placement', // 51 (P panel id index 5)
  'Queue placement', // 52 (P panel id index 6)
  'Process list placement', // 53 (P panel id index 7)
  'Goal placement', // 54 (P panel id index 8)
  'Sessions placement', // 55 (P panel id index 9)
  'Coordinator placement', // 56 (P panel id index 10)
  'Kanban placement', // 57 (P panel id index 11)
  'Connections placement', // 58 (P panel id index 12)
  'WrongProxy / WrongTrace', // 59
  'WrongProxy URL', // 60
  'Right sidebar', // 61
];
