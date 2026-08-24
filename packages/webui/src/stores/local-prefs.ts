import type { FleetChatVerbosity } from '@wrongstack/core/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectLocale } from '@/i18n/languages';

/**
 * Local preference store — persisted in localStorage.
 * Mirrors the TUI's SettingsPicker fields that don't require
 * a live WS server connection. The server can still override
 * these via WS events when connected.
 */
export interface LocalPrefs {
  /** Autonomy mode */
  autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Auto-proceed delay in ms */
  autonomyDelayMs: number;
  /** Stop auto-proceed after N iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** YOLO mode — bypass tool confirmations */
  yolo: boolean;
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
  /** Global fallback model chain (entries: `model` or `provider/model`). */
  fallbackModels: string[];
  /** Named fallback chains selectable by setmodel/model routing. */
  fallbackProfiles: Record<string, string[]>;
  /** User-curated model references prioritized by pickers and smart fallbacks. */
  favoriteModels: string[];
  /** Restrict auto-derived fallback chains to favorite models. */
  favoriteModelsOnly: boolean;
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
  /** Master enable for `wstack-auto-review`. Defaults to false (matches plugin: `cfg.enabled === true`). */
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
   * Where the local proxy daemon listens. Default `http://localhost:8000`.
   * User-editable via WebUI `IntegrationsSection` and TUI SettingsPicker.
   * Periodic probe targets `<wrongProxyUrl>/api/health`; 2xx → active.
   */
  wrongProxyUrl: string;

  set: (patch: Partial<LocalPrefs>) => void;
  reset: () => void;
}

const DEFAULTS: Omit<LocalPrefs, 'set' | 'reset'> = {
  // Default to self-driving + auto-approve, matching the core config defaults
  // (config.autonomy.defaultMode='auto', config.yolo=true). Existing browsers
  // are synced from the server's prefs snapshot on connect (handlePrefsUpdated),
  // so this only seeds fresh browsers before the first connect.
  autonomy: 'auto',
  autonomyDelayMs: 45_000,
  autoProceedMaxIterations: 50,
  yolo: true,
  maxIterations: 500,
  chime: false,
  confirmExit: true,
  fleetChatVerbosity: 'off',
  nextPrediction: false,
  nextStepsTool: false,
  fallbackModels: [],
  fallbackProfiles: {},
  favoriteModels: [],
  favoriteModelsOnly: false,
  modelMatrix: {},
  fallbackAuto: true,
  modelAvailabilitySchedule: [],
  featureMcp: true,
  featurePlugins: true,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: true,
  indexOnStart: true,
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  contextMode: 'balanced',
  tokenSavingTier: 'auto',
  maxConcurrent: 10,
  titleAnimation: true,
  logLevel: 'info',
  auditLevel: 'standard',
  enhanceEnabled: true,
  enhanceDelayMs: 60_000,
  enhanceCountdownMs: 3_000,
  enhanceLanguage: 'original',
  refinerProvider: '',
  refinerModel: '',
  refinerFallbackProfile: '',
  thinkingWord: 'thinking',
  statuslineMode: 'minimum',
  animationStyle: 'rainbow',
  showThinkingLogs: true,
  groupToolCalls: true,
  autoCollapseInput: false,
  showModelReasoning: true,
  showAgentSwarmPanel: 'bottom',
  allowOutsideProjectRoot: true,
  reasoningMode: 'auto',
  reasoningEffort: 'high',
  reasoningPreserve: false,
  cacheTtl: 'default',
  breakerEnabled: false,
  breakerAutoKillResetMs: 60_000,
  fsAccess: 'unrestricted',
  debugStream: false,
  hqEnabled: false,
  hqUrl: '',
  hqToken: '',
  hqRawContent: false,
  tgConfigured: false,
  tgSessionEnd: false,
  tgDelegate: true,
  tgLongToolMs: 30_000,
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
  // Auto-review (mid-session): mirrors ResolvedAutoReviewConfig. Strict opt-in
  // matches `cfg.enabled === true` in auto-review-plugin.ts:72.
  autoReviewEnabled: false,
  autoReviewProvider: '',
  autoReviewModel: '',
  autoReviewFallbackProfile: '',
  autoReviewModelSelection: 'round-robin',
  autoReviewFallbackModels: [],
  autoReviewDebounceMs: 15_000,
  autoReviewMaxFilesPerBatch: 15,
  autoReviewMaxConcurrentReviews: 2,
  autoReviewCascadeOn: 'off',
  pluginsEnabled: {},
  // WrongProxy / WrongTrace. Master switch defaults to off so the feature
  // ships silent; URL defaults to the dev-script daemon's documented port.
  wrongProxyEnabled: false,
  wrongProxyUrl: 'http://localhost:8000',
};

export const useLocalPrefs = create<LocalPrefs>()(
  persist(
    (set) => ({
      .../** @see LocalPrefs */ (DEFAULTS as Omit<LocalPrefs, 'set' | 'reset'>),
      set: (patch) => set(patch),
      reset: () => set(/** @see LocalPrefs */ DEFAULTS as Omit<LocalPrefs, 'set' | 'reset'>),
    }),
    {
      name: 'wrongstack-local-prefs',
      version: 16,
      // v16 (2026-08-24): added WrongProxy / WrongTrace toggles. The
      // master switch defaults to off (existing users see no behavior
      // change); the URL defaults to http://localhost:8000 (the dev-script
      // daemon port documented in the WRONGTRACE dev script). The probe
      // in `proxy-probe.ts` only fires when the toggle is on, so existing
      // users pay no cost. Older stores are backfilled via DEFAULTS spread
      // + the explicit migration guard at the bottom; no remap is needed
      // because the fields have no historical alias in localStorage.
      //
      // v15 (2026-08-04): added autoCollapseInput (display toggle). Default
      // false — the chat input no longer auto-collapses under the history.
      // Older stores are backfilled via DEFAULTS spread + the explicit
      // migration guard at the bottom; no remap is needed because the field
      // has no historical alias in localStorage.
      //
      // v14 (2026-08-02): showAgentSwarmPanel changed from boolean to
      // tri-state string ('bottom' | 'sidebar' | 'off'). Migration guard
      // validates and coerces legacy boolean values.
      //
      // v13 (2026-08-01): added TUI-SettingsPicker parity fields for
      // Display — readSymbols, showSageMemoryInject,
      // sageMemoryInjectThreshold, preRefineSeconds, multiDiffSummaryThreshold.
      // Older stores are backfilled via DEFAULTS spread + the explicit
      // migration block at the bottom; no explicit remap is needed
      // because the new fields have no historical aliases in localStorage.
      //
      // v12 (2026-07-30): raised the canonical auto-review quiet window
      // from 5s to 15s and migrates the old default once.
      //
      // v11 (2026-07-28): added showModelReasoning, showAgentSwarmPanel,
      // allowOutsideProjectRoot — backfill via DEFAULTS spread + defensive typeof guards.
      //
      // v10 (2026-07-20): streamFleet (boolean) renamed to fleetChatVerbosity
      // ('off'|'full'). Map legacy true → 'full' (was the default), legacy false
      // → 'off'. Clean up the old key from localStorage.
      //
      // v9 stored Chimera + auto-review settings (chimeraEnabled, chimeraProvider,
      // …). Older stores get defaults via DEFAULTS spread; no explicit remap needed.
      //
      // v1 stored option values that don't exist in core's config schema —
      // contextStrategy frugal/balanced/deep/archival (context-window modes,
      // a different setting) and auditLevel 'verbose'. Map them onto the
      // canonical values so persisted stores don't resurrect invalid prefs.
      //
      // v2 added autoProceedMaxIterations.
      //
      // v3 added Telegram notification prefs (tgConfigured, tgSessionEnd,
      // tgDelegate, tgLongToolMs). Older stores simply get the defaults via
      // the spread of DEFAULTS; no explicit remap is needed.
      //
      // v4 added fallbackProfiles/favoriteModels/favoriteModelsOnly/modelMatrix.
      //
      // v5 added uiLocale (display-only UI language).
      //
      // v6 added showThinkingLogs / groupToolCalls (display toggles). Older
      // stores get the defaults via DEFAULTS spread; no remap needed.
      //
      // v8 added breakerEnabled / breakerAutoKillResetMs / fsAccess /
      // debugStream (safety & system prefs, parity with /settings).
      //
      // v9 added Chimera + auto-review settings (chimeraEnabled, chimeraProvider,
      // chimeraModel, chimeraMaxFiles, autoReviewEnabled, autoReviewProvider,
      // autoReviewModel, autoReviewFallbackProfile, autoReviewFallbackModels,
      // autoReviewDebounceMs, autoReviewMaxFilesPerBatch,
      // autoReviewMaxConcurrentReviews, autoReviewCascadeOn). Older stores
      // simply get the defaults via the spread of DEFAULTS; no explicit remap
      // is needed.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<LocalPrefs> & Record<string, unknown>;

        if (version < 12 && p.autoReviewDebounceMs === 5_000) {
          p.autoReviewDebounceMs = 15_000;
        }

        // v10: streamFleet (boolean) renamed to fleetChatVerbosity ('off'|'full').
        // Map legacy true → 'full' (was the default), legacy false → 'off'.
        if (typeof p.fleetChatVerbosity !== 'string') {
          if (p.streamFleet === true) p.fleetChatVerbosity = 'full';
          else if (p.streamFleet === false) p.fleetChatVerbosity = 'off';
          else p.fleetChatVerbosity = 'off';
          delete p.streamFleet;
        }
        // enum allow-list for the new field — reject any non-member value
        if (p.fleetChatVerbosity !== 'off' && p.fleetChatVerbosity !== 'full') {
          p.fleetChatVerbosity = 'off';
        }

        const validStrategies = ['hybrid', 'intelligent', 'selective'];
        if (!validStrategies.includes(p.contextStrategy as string)) {
          p.contextStrategy = 'hybrid';
        }
        if ((p as Record<string, unknown>)['auditLevel'] === 'verbose') p.auditLevel = 'full';
        if (!['minimal', 'standard', 'full'].includes(p.auditLevel as string)) {
          p.auditLevel = 'standard';
        }
        if (typeof p.autoProceedMaxIterations !== 'number') {
          p.autoProceedMaxIterations = 50;
        }
        if (
          !p.fallbackProfiles ||
          typeof p.fallbackProfiles !== 'object' ||
          Array.isArray(p.fallbackProfiles)
        ) {
          p.fallbackProfiles = {};
        }
        if (!Array.isArray(p.favoriteModels)) p.favoriteModels = [];
        if (typeof p.favoriteModelsOnly !== 'boolean') p.favoriteModelsOnly = false;
        if (!Array.isArray(p.modelAvailabilitySchedule)) p.modelAvailabilitySchedule = [];
        if (!p.modelMatrix || typeof p.modelMatrix !== 'object' || Array.isArray(p.modelMatrix)) {
          p.modelMatrix = {};
        }
        if (typeof p.uiLocale !== 'string' || !p.uiLocale) {
          // Backfill older stores with the browser-detected language.
          p.uiLocale = detectLocale();
        }
        if (typeof p.breakerEnabled !== 'boolean') p.breakerEnabled = false;
        if (typeof p.breakerAutoKillResetMs !== 'number') p.breakerAutoKillResetMs = 60_000;
        if (p.fsAccess !== 'unrestricted' && p.fsAccess !== 'project') p.fsAccess = 'unrestricted';
        if (typeof p.debugStream !== 'boolean') p.debugStream = false;
        // v16: WrongProxy / WrongTrace. Both fields are independent of any
        // historical alias, but we still type-check so a corrupted persisted
        // value (e.g. `"yes"`, 123) doesn't survive into the live store and
        // reach the WebUI/TUI panels + the CLI probe as a non-member value.
        // Mirrors the typeof-style guards used for `breakerEnabled` /
        // `debugStream` directly above.
        if (typeof p.wrongProxyEnabled !== 'boolean') p.wrongProxyEnabled = false;
        if (typeof p.wrongProxyUrl !== 'string' || p.wrongProxyUrl.trim().length === 0) {
          p.wrongProxyUrl = 'http://localhost:8000';
        }
        // Chimera/auto-review migration — backfill with the canonical defaults
        // so persisted stores from pre-v9 don't expose `undefined` to the panel.
        if (typeof p.chimeraEnabled !== 'boolean') p.chimeraEnabled = true;
        if (typeof p.chimeraProvider !== 'string') p.chimeraProvider = '';
        if (typeof p.chimeraModel !== 'string') p.chimeraModel = '';
        // chimeraAutoFix: enum allow-list (off | ask | auto). Without this
        // guard a legacy/corrupt persisted value (e.g. 'always') would
        // survive migration and reach the panel + plugin as a non-member
        // string. Mirrors the sibling autoReviewCascadeOn guard below.
        if (
          p.chimeraAutoFix !== 'off' &&
          p.chimeraAutoFix !== 'ask' &&
          p.chimeraAutoFix !== 'auto'
        ) {
          p.chimeraAutoFix = 'off';
        }
        // chimeraMaxFiles: must be a finite number AND >= 1. The plugin's
        // resolver uses `?? DEFAULT_MAX_FILES` without clamping, so a 0,
        // NaN, or Infinity here would silently no-op the review. `typeof`
        // narrows for TypeScript; `Number.isFinite` rejects NaN/Infinity.
        if (
          typeof p.chimeraMaxFiles !== 'number' ||
          !Number.isFinite(p.chimeraMaxFiles) ||
          p.chimeraMaxFiles < 1
        ) {
          p.chimeraMaxFiles = 15;
        }
        if (typeof p.autoReviewEnabled !== 'boolean') p.autoReviewEnabled = false;
        if (typeof p.autoReviewProvider !== 'string') p.autoReviewProvider = '';
        if (typeof p.autoReviewModel !== 'string') p.autoReviewModel = '';
        if (typeof p.autoReviewFallbackProfile !== 'string') p.autoReviewFallbackProfile = '';
        if (
          p.autoReviewModelSelection !== 'round-robin' &&
          p.autoReviewModelSelection !== 'random'
        ) {
          p.autoReviewModelSelection = 'round-robin';
        }
        if (!Array.isArray(p.autoReviewFallbackModels)) p.autoReviewFallbackModels = [];
        // autoReviewDebounceMs: must be a finite number AND >= 0 (0 is a
        // valid "no debounce" choice, so the bound is `>= 0` not `> 0`).
        // `typeof` narrows for TypeScript; `Number.isFinite` rejects NaN/Infinity.
        if (
          typeof p.autoReviewDebounceMs !== 'number' ||
          !Number.isFinite(p.autoReviewDebounceMs) ||
          p.autoReviewDebounceMs < 0
        ) {
          p.autoReviewDebounceMs = 15_000;
        }
        if (
          typeof p.autoReviewMaxFilesPerBatch !== 'number' ||
          !Number.isFinite(p.autoReviewMaxFilesPerBatch) ||
          p.autoReviewMaxFilesPerBatch < 1
        ) {
          p.autoReviewMaxFilesPerBatch = 15;
        }
        if (
          typeof p.autoReviewMaxConcurrentReviews !== 'number' ||
          !Number.isFinite(p.autoReviewMaxConcurrentReviews) ||
          p.autoReviewMaxConcurrentReviews < 1
        ) {
          p.autoReviewMaxConcurrentReviews = 2;
        }
        if (
          p.autoReviewCascadeOn !== 'off' &&
          p.autoReviewCascadeOn !== 'critical' &&
          p.autoReviewCascadeOn !== 'high'
        ) {
          p.autoReviewCascadeOn = 'off';
        }
        // v11: new boolean flags — backfill with defaults
        if (typeof p.showModelReasoning !== 'boolean') p.showModelReasoning = true;
        // v15: autoCollapseInput — boolean display toggle, default false
        // (input starts expanded; auto-collapse is opt-in).
        if (typeof p.autoCollapseInput !== 'boolean') p.autoCollapseInput = false;
        // v14: showAgentSwarmPanel changed from boolean to tri-state string.
        // Legacy booleans: true → 'bottom', false → 'off'.
        // Invalid values (non-string, non-boolean) → 'bottom' (default).
        if (typeof p.showAgentSwarmPanel === 'boolean') {
          p.showAgentSwarmPanel = p.showAgentSwarmPanel ? 'bottom' : 'off';
        } else if (
          typeof p.showAgentSwarmPanel !== 'string' ||
          !['bottom', 'sidebar', 'off'].includes(p.showAgentSwarmPanel)
        ) {
          p.showAgentSwarmPanel = 'bottom';
        }
        if (typeof p.allowOutsideProjectRoot !== 'boolean') p.allowOutsideProjectRoot = true;
        // v13: TUI-SettingsPicker Display parity fields. The boolean ones
        // mirror their v11 sibling guard pattern. The numeric ones need
        // Number.isFinite + a sane range so a corrupted localStorage value
        // (NaN, Infinity, negative) cannot poison the panel or downstream
        // consumers. Defaults match TUI `SETTINGS_DEFAULTS`.
        if (typeof p.readSymbols !== 'boolean') p.readSymbols = false;
        if (typeof p.showSageMemoryInject !== 'boolean') p.showSageMemoryInject = false;
        if (
          typeof p.sageMemoryInjectThreshold !== 'number' ||
          !Number.isFinite(p.sageMemoryInjectThreshold) ||
          p.sageMemoryInjectThreshold < 0 ||
          p.sageMemoryInjectThreshold > 1
        ) {
          p.sageMemoryInjectThreshold = 0.85;
        }
        if (
          typeof p.preRefineSeconds !== 'number' ||
          !Number.isFinite(p.preRefineSeconds) ||
          p.preRefineSeconds < 0
        ) {
          p.preRefineSeconds = 3;
        }
        if (
          typeof p.multiDiffSummaryThreshold !== 'number' ||
          !Number.isFinite(p.multiDiffSummaryThreshold) ||
          p.multiDiffSummaryThreshold < 0
        ) {
          p.multiDiffSummaryThreshold = 5;
        }
        return p as never as LocalPrefs;
      },
      // `hqToken` is a bearer credential for the HQ control plane. The whole
      // prefs object was persisted with no `partialize`, so it sat in
      // `localStorage` under `wrongstack-local-prefs` in cleartext — readable
      // from DevTools or any same-origin script, and surviving until the user
      // clears site data. `config-store.ts:73-88` (WS-069) already removed
      // `apiKey` from its own persist for exactly this reason; the same rule
      // has to cover the HQ token.
      //
      // The value still lives in memory for the session, so Settings →
      // Integrations keeps working; it just no longer outlives the tab.
      partialize: (state) => {
        const { hqToken: _omitted, ...rest } = state;
        return rest as unknown as LocalPrefs;
      },
      // Builds before this change wrote a token; dropping it from `partialize`
      // alone would leave that value in storage and rehydrate it on every
      // load. Strip on read so the next persist clears it from disk too.
      merge: (persisted, current) => {
        const { hqToken: _discardedLegacyHqToken, ...rest } =
          (persisted as Partial<LocalPrefs> | undefined) ?? {};
        return { ...current, ...rest, hqToken: '' };
      },
    },
  ),
);
