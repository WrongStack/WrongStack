import type { FleetChatVerbosity } from '@wrongstack/contracts/types';

import { detectLocale } from '@/i18n/languages';

/**
 * Local preference store — persisted in localStorage.
 * Mirrors the TUI's SettingsPicker fields that don't require
 * a live WS server connection. The server can still override
 * these via WS events when connected.
 */
export interface LocalPrefs {
  /** Allow delegated and autonomous subagents in this session. */
  subagentsAllowed: boolean;
  /**
   * With `subagentsAllowed` off, still let the Director's companions run
   * (solo policy `companions`). Only meaningful alongside a solo session.
   */
  subagentCompanionsAllowed: boolean;
  /** Server-derived lock: true after the first user message. */
  subagentsPolicyLocked: boolean;
  /** Autonomy mode */
  autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Auto-proceed delay in ms */
  autonomyDelayMs: number;
  /** Stop auto-proceed after N iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** YOLO mode — bypass tool confirmations */
  yolo: boolean;
  /**
   * Which kinds of damage still prompt while YOLO is on, keyed by
   * `DestructiveKind`. A missing key means "still asks" — the fail-closed
   * reading — so an older client that omits a newer kind cannot un-gate it.
   *
   * Machine-level, NOT session-scoped: unlike `yolo` (a per-tab mode), this
   * answers what the agent may destroy unattended anywhere.
   */
  yoloConfirm: Record<string, boolean>;
  /** Maximum agent iterations per run */
  maxIterations: number;
  /** Chime on run completion */
  chime: boolean;
  /** Confirm before exit (Ctrl+C) */
  confirmExit: boolean;
  /** Fleet-chat verbosity (off | full) */
  fleetChatVerbosity: FleetChatVerbosity;
  /** Predict next steps after turn completes */
  nextPrediction: boolean;
  /**
   * Register the leader's agent-callable `nextsteps` tool alongside the
   * `<nextsteps>` block it can already write. Persisted to
   * `tools.nextsteps.enabled`; the tool registry is built at boot, so the
   * change takes effect in the next session.
   */
  nextStepsTool: boolean;
  /** `autonomy.nextSteps` — required = every finished turn ends with suggestions. */
  nextStepsMode: 'optional' | 'required';
  /** YOLO+ — every call allowed, nothing asks (deny rules still refuse). Implies YOLO. */
  yoloPlus: boolean;
  /** Global fallback model chain (entries: `model` or `provider/model`). */
  fallbackModels: string[];
  /** Named fallback chains selectable by setmodel/model routing. */
  fallbackProfiles: Record<string, string[]>;
  /** User-curated model references prioritized by pickers and smart fallbacks. */
  favoriteModels: string[];
  /** Provider-qualified models intentionally hidden from selection and fallback routing. */
  disabledModels: string[];
  /** Provider ids intentionally switched off: every one of their models is hidden and skipped. */
  disabledProviders: string[];
  /** Restrict auto-derived fallback chains to favorite models. */
  favoriteModelsOnly: boolean;
  /**
   * Session-scoped subagent model lanes. Each live subagent holds one lane, so
   * a fan-out runs on as many different provider/model pairs as there are
   * pinned lanes. `lock` decides whether a lane outranks the provider/model the
   * leader passed to `spawn_subagent` / `delegate`. Never written to
   * config.json — the server journals it with the session.
   */
  subagentModelPlan: {
    enabled: boolean;
    lock: boolean;
    /** Run every plain subagent on the session's own model; outranks the lanes. */
    followSessionModel?: boolean;
    slots: Array<{
      provider?: string;
      model?: string;
      tier?: string;
      fallbackProfile?: string;
      label?: string;
    }>;
    roles?: Record<
      string,
      { provider?: string; model?: string; tier?: string; fallbackProfile?: string }
    >;
  };
  /** Per-role/phase/default model routing matrix. */
  modelMatrix: Record<
    string,
    {
      provider?: string;
      model?: string;
      fallbackProfile?: string;
      modelRuntime?: {
        reasoning?: { mode?: 'auto' | 'on' | 'off'; effort?: string; preserve?: boolean };
        cache?: { ttl?: '5m' | '1h' };
        parameters?: Record<string, unknown>;
      };
    }
  >;
  /**
   * User-chosen limits (`Config.limits`). Every field is optional; an unset
   * field means no limit — the model, catalog or provider decides.
   */
  limits: {
    responseOutputTokens?: number;
    toolOutputPreviewBytes?: number;
    fetchBytes?: number;
    projectInstructionsChars?: number;
    memoryInjectChars?: number;
    historyMessages?: number;
    subagentResultChars?: number;
    subagentDefaultBudget?: { maxIterations?: number; maxToolCalls?: number; timeoutMs?: number };
  };
  /**
   * Deterministic cost tiers. A level binds a fallback profile, a spend budget
   * and runtime overrides under one name; `routing` maps a role/phase/`*` to a
   * level; `leader` governs how much authority the leader has over its own tier.
   */
  modelTiers: {
    enabled?: boolean;
    default?: string;
    levels?: Record<
      string,
      {
        fallbackProfile?: string;
        provider?: string;
        model?: string;
        maxCostUsd?: number;
        maxIterations?: number;
        maxToolCalls?: number;
        maxTokens?: number;
        timeoutMs?: number;
        description?: string;
        modelRuntime?: {
          reasoning?: { mode?: 'auto' | 'on' | 'off'; effort?: string; preserve?: boolean };
          cache?: { ttl?: '5m' | '1h' };
        };
      }
    >;
    routing?: Record<string, string>;
    leader?: {
      mode?: 'off' | 'propose' | 'auto';
      dwellTurns?: number;
      minSavingsUsd?: number;
      maxContextFillForSwitch?: number;
      maxTier?: string;
    };
  };
  /** Auto-derive a fallback chain from keyed providers when the list is empty. */
  fallbackAuto: boolean;
  /** Recurring provider/model blackout windows for autonomous routing. */
  modelAvailabilitySchedule: import('@wrongstack/core/models').ModelBlackoutRule[];

  // --- Feature flags ---
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  featureToolCoach: boolean;
  indexOnStart: boolean;

  /** Per-plugin enabled/disabled state. Keys are plugin names (e.g. "wstack-chimera"). */
  pluginsEnabled: Record<string, boolean>;

  // --- Context ---
  contextAutoCompact: boolean;
  /** Compactor strategy — matches core's config.context.strategy. */
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  /** Context window mode — matches core's config.context.mode. */
  contextMode: 'balanced' | 'frugal' | 'deep';
  /** Token-saving mode — matches core's config.features.tokenSavingMode. */
  tokenSavingTier: 'auto' | 'off' | 'minimal' | 'light' | 'medium' | 'aggressive';
  /** Max concurrent subagents */
  maxConcurrent: number;
  /** Terminal title animation */
  titleAnimation: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Session audit detail — matches core's config.session.auditLevel. */
  auditLevel: 'minimal' | 'standard' | 'full';

  // --- Refine ---
  enhanceEnabled: boolean;
  enhanceDelayMs: number;
  /** Pre-refine grace countdown (ms) before the refiner call starts. */
  enhanceCountdownMs: number;
  enhanceLanguage: 'original' | 'english';
  /** Provider id for goal refinement (`/goal set`). Empty = use session provider. */
  refinerProvider: string;
  /** Model id for goal refinement. Empty = use session model. */
  refinerModel: string;
  /** Named fallback profile for goal refinement. Empty = use refinerProvider+refinerModel or session defaults. */
  refinerFallbackProfile: string;

  /** TUI status-chip word (e.g. "thinking", "vibing"). */
  thinkingWord: string;
  /** TUI statusline density. */
  statuslineMode: 'minimum' | 'detailed' | 'no-color';
  /** TUI working-chip animation style. */
  animationStyle: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'static' | 'cycle';

  // --- Display toggles ---
  /** Show completed thinking/logic blocks in chat history */
  showThinkingLogs: boolean;
  /** Group consecutive tool calls into collapsible chips */
  groupToolCalls: boolean;
  /** Auto-collapse the chat input under the history when a session with
   *  messages loads (opt-in; off by default). When off, the input always
   *  starts expanded. Independent of the manual collapse/expand buttons. */
  autoCollapseInput: boolean;
  /**
   * How much workbench chrome is on screen. `calm` shows each figure (tokens,
   * iteration, server health, …) in ONE place and tucks secondary controls
   * behind menus; `full` restores every duplicate and loose control exactly as
   * it was. Local-only — never synced to the server.
   */
  chromeLevel: 'calm' | 'full';
  /** Session panel "Session" stats grid expanded (calm chrome folds it). */
  sessionStatsExpanded: boolean;
  /** Show model reasoning/thinking blocks inline in the chat */
  showModelReasoning: boolean;
  /** Agent swarm panel placement: bottom, sidebar, or off */
  showAgentSwarmPanel: 'bottom' | 'sidebar' | 'off';
  /** Allow tools to access paths outside the project root (inverse of fsAccess). */
  allowOutsideProjectRoot: boolean;

  // --- Reasoning / cache runtime ---
  reasoningMode: 'auto' | 'on' | 'off';
  reasoningEffort: string;
  reasoningPreserve: boolean;
  cacheTtl: 'default' | '5m' | '1h';

  // --- Safety / system ---
  /** Process circuit breaker — gates bash/exec after repeated failures. */
  breakerEnabled: boolean;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs: number;
  /** File-tool access scope. 'project' confines file tools to the project root (restart to apply). */
  fsAccess: 'unrestricted' | 'project';
  /** Raw SSE hex-dump to the server's stderr for provider debugging. */
  debugStream: boolean;

  // --- HQ client publishing ---
  hqEnabled: boolean;
  hqUrl: string;
  hqToken: string;
  hqRawContent: boolean;

  // --- Telegram notifications ---
  /** Plugin configured with a bot token (gates the whole section). */
  tgConfigured: boolean;
  tgSessionEnd: boolean;
  tgDelegate: boolean;
  /** Long-tool threshold in ms. 0 = disabled. */
  tgLongToolMs: number;
  /**
   * Bot polling interval in seconds. 1–60; the server rejects anything
   * outside that range, matching `/telegram-settings poll`.
   */
  tgPollIntervalSec: number;
  /**
   * Default chat ID for notifications (`extensions.telegram.notifyChatId`).
   * Empty string = not set. Positive = private chat (paired with the bot);
   * negative = group/channel, which the server refuses unless the config
   * sets `allowGroupChats: true`.
   */
  tgChatId: string;

  /**
   * Display-only UI language (BCP-47 code, e.g. `en`, `pt-BR`).
   * Synced through prefs.update into shared Config.uiLocale so browser WebUI,
   * desktop-hosted WebUI, and the desktop shell follow the same choice.
   * Distinct from `enhanceLanguage` (a prompt-refinement pref).
   */
  uiLocale: string;

  /** How Chimera review findings are handled. */
  chimeraAutoFix: 'off' | 'ask' | 'auto';

  // --- Display toggles (TUI SettingsPicker parity) ---
  /** When true, the read tool includes codebase-index symbols in its output.
   *  Mirrors TUI field 42 (`readSymbols`) persisted as
   *  `autonomy.readAdvancedMode`. */
  readSymbols: boolean;
  /** When true, SAGE memory-inject blocks are surfaced in tool results.
   *  Mirrors TUI field 43 (`showSageMemoryInject`). */
  showSageMemoryInject: boolean;
  /** Minimum relation strength for SAGE memory injection. Mirrors TUI field
   *  44 (`sageMemoryInjectThreshold`) persisted as
   *  `Sage.inject.relationFloor`. */
  sageMemoryInjectThreshold: number;
  /** Pre-refine grace countdown in SECONDS (TUI field 41). 0 = skip the
   *  countdown and run the refiner immediately. Presets:
   *  0, 2, 3, 5, 8, 10. Distinct from `enhanceCountdownMs` (a TUI-internal
   *  ms value used by the simpleui RefinePanel animation). */
  preRefineSeconds: number;
  /** Minimum number of files before the multi-file diff summary footer
   *  renders above the per-file blocks. 0 disables the footer. Mirrors TUI
   *  field 21 (`multiDiffSummaryThreshold`). */
  multiDiffSummaryThreshold: number;

  // ── Chimera (post-session review) — mirrors ResolvedChimeraConfig ──
  /** Master enable for `wstack-chimera`. Defaults to true (matches plugin: `cfg.enabled !== false`). */
  chimeraEnabled: boolean;
  /** Override provider id for the review subagent. Empty = use session provider. */
  chimeraProvider: string;
  /** Override model id for the review subagent. Empty = use session model. */
  chimeraModel: string;
  /** Maximum number of files considered per review (default 15). */
  chimeraMaxFiles: number;

  // ── Auto-review (mid-session continuous) — mirrors ResolvedAutoReviewConfig ──
  /** Master enable for `wstack-auto-review`. Defaults to true (matches plugin: `cfg.enabled !== false`). */
  autoReviewEnabled: boolean;
  /** Override provider id for the review subagent. Empty = resolve via fallbackProfile/effective chain. */
  autoReviewProvider: string;
  /** Override model id for the review subagent. Empty = resolve via fallbackProfile/effective chain. */
  autoReviewModel: string;
  /** Named fallback profile (from `config.fallbackProfiles`) used to derive provider/model + fallback chain. */
  autoReviewFallbackProfile: string;
  /** Starting-model policy for the selected auto-review profile. */
  autoReviewModelSelection: 'round-robin' | 'random';
  /** Explicit fallback chain (derived when no fallbackProfile is set, surfaced for visibility). */
  autoReviewFallbackModels: string[];
  /** Debounce window in ms — wait for quiet before firing review (default 15000). */
  autoReviewDebounceMs: number;
  /** Max files per review batch (default 15). */
  autoReviewMaxFilesPerBatch: number;
  /** Max concurrent in-flight reviews (default 2). */
  autoReviewMaxConcurrentReviews: number;
  /** Cascade severity threshold: when a review finds findings at or above this level, spawn follow-up agents. */
  autoReviewCascadeOn: 'off' | 'critical' | 'high';

  // ── WrongProxy / WrongTrace (automatic base-URL rerouting) ─────────────
  /**
   * Master switch. When true AND the daemon at `wrongProxyUrl` is
   * reachable, every provider's base URL flows through
   * `${wrongProxyUrl}/proxy/<host><path>`. Excluded providers
   * (openai-codex) flow through unchanged.
   */
  wrongProxyEnabled: boolean;
  /**
   * Where the local proxy daemon listens. Default `http://localhost:3444`.
   * User-editable via WebUI `IntegrationsSection` and TUI SettingsPicker.
   * Periodic probe targets `<wrongProxyUrl>/api/health`; 2xx → active.
   */
  wrongProxyUrl: string;

  /** Master toggle for global keyboard shortcuts. Defaults to false. */
  keyboardShortcuts: boolean;

  /**
   * Per-session overrides for the keys in `SESSION_SCOPED_PREF_KEYS`.
   *
   * The flat fields above are the EFFECTIVE view of the tab in front, so
   * existing readers (`useLocalPrefs((s) => s.autonomy)`) keep working and
   * automatically describe the right tab. This map is what makes them
   * per-tab rather than one value the four tabs fight over.
   */
  bySession: Record<string, Partial<LocalPrefs>>;
  /**
   * What a NEWLY opened tab inherits for the session-scoped keys — the last
   * value the user chose, mirroring the server, which persists the same keys
   * to config as the default a new tab starts from.
   */
  sessionDefaults: Partial<LocalPrefs>;
  /** Which session the flat fields currently describe. */
  activeSessionId: string | null;

  set: (patch: Partial<LocalPrefs>) => void;
  /** Point the flat fields at a tab, materialising its overrides. */
  bindSession: (sessionId: string | null) => void;
  /**
   * Apply a server-sent patch. `sessionId` names the tab it belongs to; a
   * patch for a BACKGROUND tab updates that tab's override and leaves the
   * fields the UI is rendering alone.
   */
  applyRemote: (patch: Partial<LocalPrefs>, sessionId?: string | undefined) => void;
  /** Forget a closed tab's overrides. */
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

/** The data half of the store — everything except the action methods. */
export type LocalPrefsData = Omit<
  LocalPrefs,
  'set' | 'reset' | 'bindSession' | 'applyRemote' | 'forgetSession'
>;

export const DEFAULTS: LocalPrefsData = {
  subagentsAllowed: true,
  subagentCompanionsAllowed: false,
  subagentsPolicyLocked: false,
  // Default to self-driving + auto-approve, matching the core config defaults
  // (config.autonomy.defaultMode='auto', config.yolo=true). Existing browsers
  // are synced from the server's prefs snapshot on connect (handlePrefsUpdated),
  // so this only seeds fresh browsers before the first connect.
  autonomy: 'auto',
  autonomyDelayMs: 15_000,
  autoProceedMaxIterations: 0,
  yolo: true,
  yoloConfirm: {
    'disk-wipe': true,
    'system-halt': true,
    'delete-outside': true,
    'git-history': true,
    publish: true,
    'download-and-run': true,
    'bulk-delete': true,
    'agent-state': true,
    'credential-bind': true,
  },
  maxIterations: 0,
  chime: true,
  confirmExit: true,
  fleetChatVerbosity: 'off',
  nextPrediction: true,
  nextStepsTool: false,
  nextStepsMode: 'required',
  yoloPlus: false,
  fallbackModels: [],
  fallbackProfiles: {},
  favoriteModels: [],
  disabledModels: [],
  disabledProviders: [],
  favoriteModelsOnly: false,
  modelMatrix: {},
  subagentModelPlan: { enabled: true, lock: true, followSessionModel: false, slots: [] },
  modelTiers: {},
  limits: {},
  fallbackAuto: true,
  modelAvailabilitySchedule: [],
  featureMcp: true,
  featurePlugins: true,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: true,
  featureToolCoach: true,
  indexOnStart: true,
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  contextMode: 'balanced',
  tokenSavingTier: 'auto',
  maxConcurrent: 10,
  titleAnimation: true,
  logLevel: 'warn',
  auditLevel: 'full',
  enhanceEnabled: true,
  enhanceDelayMs: 15_000,
  enhanceCountdownMs: 3_000,
  enhanceLanguage: 'english',
  refinerProvider: '',
  refinerModel: '',
  refinerFallbackProfile: '',
  thinkingWord: 'thinking',
  statuslineMode: 'minimum',
  animationStyle: 'rainbow',
  showThinkingLogs: true,
  groupToolCalls: true,
  autoCollapseInput: false,
  chromeLevel: 'calm',
  sessionStatsExpanded: false,
  showModelReasoning: false,
  showAgentSwarmPanel: 'bottom',
  allowOutsideProjectRoot: true,
  reasoningMode: 'auto',
  reasoningEffort: 'medium',
  reasoningPreserve: false,
  cacheTtl: 'default',
  breakerEnabled: false,
  breakerAutoKillResetMs: 60_000,
  fsAccess: 'unrestricted',
  debugStream: true,
  hqEnabled: false,
  hqUrl: '',
  hqToken: '',
  hqRawContent: false,
  tgConfigured: false,
  tgSessionEnd: false,
  tgDelegate: true,
  tgLongToolMs: 30_000,
  // Telegram polling interval (s) and default notification chat. Defaults
  // mirror telegram's DEFAULT_CONFIG (packages/telegram/src/config.ts:86)
  // and the server seeds in context-meta.ts.
  tgPollIntervalSec: 2,
  tgChatId: '',
  uiLocale: detectLocale(),
  chimeraAutoFix: 'off',
  // Display toggles (TUI SettingsPicker parity — fields 21, 41, 42, 43, 44).
  // Defaults mirror the TUI's SettingsPicker model: `SETTINGS_DEFAULTS` in
  // packages/tui/src/components/settings-picker-model.ts:787. Server-side
  // overrides from the WS `prefs.snapshot` always win on connect.
  readSymbols: false,
  showSageMemoryInject: false,
  sageMemoryInjectThreshold: 0.85,
  preRefineSeconds: 3,
  multiDiffSummaryThreshold: 5,
  // Chimera (post-session): mirrors ResolvedChimeraConfig. Enabled-by-default
  // matches `cfg.enabled !== false` in chimera-plugin.ts:50.
  chimeraEnabled: true,
  chimeraProvider: '',
  chimeraModel: '',
  chimeraMaxFiles: 15,
  // Auto-review (mid-session): mirrors ResolvedAutoReviewConfig. Enabled-by-default
  // matches `cfg.enabled !== false` in auto-review-plugin.ts; cascade 'high' is
  // the inclusive threshold ('off'/'critical' only when configured).
  autoReviewEnabled: true,
  autoReviewProvider: '',
  autoReviewModel: '',
  autoReviewFallbackProfile: '',
  autoReviewModelSelection: 'round-robin',
  autoReviewFallbackModels: [],
  autoReviewDebounceMs: 15_000,
  autoReviewMaxFilesPerBatch: 15,
  autoReviewMaxConcurrentReviews: 2,
  autoReviewCascadeOn: 'high',
  pluginsEnabled: {},
  // WrongProxy / WrongTrace. Master switch defaults to off so the feature
  // ships silent; URL defaults to the dev-script daemon's documented port.
  wrongProxyEnabled: false,
  wrongProxyUrl: 'http://localhost:3444',
  keyboardShortcuts: false,
  bySession: {},
  sessionDefaults: {},
  activeSessionId: null,
};
