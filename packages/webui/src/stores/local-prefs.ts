import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectLocale } from '@/i18n/languages';
import { DEFAULTS, type LocalPrefs, type LocalPrefsData } from './local-prefs-defaults.js';

export type { LocalPrefs } from './local-prefs-defaults.js';

/**
 * Preferences that belong to ONE session rather than to the browser.
 *
 * Must stay in step with `SESSION_SCOPED_PREF_KEYS` on the server
 * (`webui-server/src/server/prefs-handlers.ts`) — the server already keys
 * these off the calling tab's context meta, and a client that treats them as
 * global shows tab 1's autonomy while tab 3 is on screen. Parity is enforced
 * by `tests/server/session-scoped-prefs-parity.test.ts`, not by memory.
 */
export const SESSION_SCOPED_PREFS = [
  'subagentsAllowed',
  'subagentCompanionsAllowed',
  'subagentsPolicyLocked',
  'subagentModelPlan',
  'acpRuntime',
  'autonomy',
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'yolo',
  'yoloPlus',
  'maxIterations',
  'contextStrategy',
  'contextMode',
  'contextAutoCompact',
  'tokenSavingTier',
  'systemPromptVariant',
  'reasoningMode',
  'reasoningEffort',
  'reasoningPreserve',
  'nextPrediction',
  'nextStepsTool',
  'nextStepsMode',
] as const satisfies ReadonlyArray<string>;

const SESSION_SCOPED_PREF_SET: ReadonlySet<string> = new Set(SESSION_SCOPED_PREFS);

/**
 * The effective value of a session-scoped preference for ONE session.
 *
 * Reading the flat field answers for the tab IN FRONT, which is wrong whenever
 * the question is about another tab. The dangerous instance was `yolo`: a
 * background tab's tool-approval prompt was auto-approved because the tab the
 * user happened to be looking at had YOLO on — approving a tool in a session
 * the user never put in that mode.
 */
export function sessionPref<K extends keyof LocalPrefs>(
  sessionId: string | null | undefined,
  key: K,
): LocalPrefs[K] {
  const state = useLocalPrefs.getState();
  if (!sessionId || sessionId === state.activeSessionId) return state[key];
  const override = state.bySession[sessionId]?.[key];
  if (override !== undefined) return override as LocalPrefs[K];
  const fallback = state.sessionDefaults[key];
  return (fallback !== undefined ? fallback : state[key]) as LocalPrefs[K];
}

/** Split a patch into the half that belongs to a tab and the half that does not. */
function splitScoped(patch: Partial<LocalPrefs>): {
  scoped: Partial<LocalPrefs>;
  shared: Partial<LocalPrefs>;
} {
  const scoped: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    // Every scoped key holds data; anything else — including an action
    // override — passes through as a plain top-level write rather than being
    // silently dropped.
    if (SESSION_SCOPED_PREF_SET.has(key) && typeof value !== 'function') scoped[key] = value;
    else shared[key] = value;
  }
  return { scoped: scoped as Partial<LocalPrefs>, shared: shared as Partial<LocalPrefs> };
}

export const useLocalPrefs = create<LocalPrefs>()(
  persist(
    (set) => ({
      ...(DEFAULTS as LocalPrefsData),

      /**
       * A local edit. Session-scoped keys land on the tab in front (and become
       * the default the next new tab inherits); everything else is browser-wide.
       * The flat fields always mirror the active tab, so the UI updates either
       * way.
       */
      set: (patch) =>
        set((state) => {
          const { scoped, shared } = splitScoped(patch);
          if (Object.keys(scoped).length === 0) return { ...shared };
          const sid = state.activeSessionId;
          return {
            ...shared,
            ...scoped,
            sessionDefaults: { ...state.sessionDefaults, ...scoped },
            ...(sid
              ? {
                  bySession: {
                    ...state.bySession,
                    [sid]: { ...(state.bySession[sid] ?? {}), ...scoped },
                  },
                }
              : {}),
          };
        }),

      bindSession: (sessionId) =>
        set((state) => {
          if (state.activeSessionId === sessionId) return {};
          // Park the outgoing tab's current values so an edit made before the
          // server echoed it back is not lost on the way out.
          const bySession = { ...state.bySession };
          if (state.activeSessionId) {
            const outgoing: Record<string, unknown> = {};
            for (const key of SESSION_SCOPED_PREFS) {
              outgoing[key] = (state as unknown as Record<string, unknown>)[key];
            }
            bySession[state.activeSessionId] = {
              ...(bySession[state.activeSessionId] ?? {}),
              ...(outgoing as Partial<LocalPrefs>),
            };
          }
          // A tab we have never seen inherits the current defaults, which is
          // what the server hands a freshly created session too.
          const incoming = sessionId
            ? { ...state.sessionDefaults, ...(bySession[sessionId] ?? {}) }
            : state.sessionDefaults;
          return { ...incoming, bySession, activeSessionId: sessionId };
        }),

      applyRemote: (patch, sessionId) =>
        set((state) => {
          const { scoped, shared } = splitScoped(patch);
          // Untagged, or addressed at the tab in front: it describes what the
          // UI is showing.
          if (!sessionId || sessionId === state.activeSessionId) {
            const sid = sessionId ?? state.activeSessionId;
            return {
              ...shared,
              ...scoped,
              ...(sid && Object.keys(scoped).length > 0
                ? {
                    bySession: {
                      ...state.bySession,
                      [sid]: { ...(state.bySession[sid] ?? {}), ...scoped },
                    },
                  }
                : {}),
            };
          }
          // A background tab's settings changed. Record them against that tab
          // and leave the visible pickers alone — writing them here is exactly
          // how one tab's autonomy ended up displayed on another's.
          if (Object.keys(scoped).length === 0) return { ...shared };
          return {
            ...shared,
            bySession: {
              ...state.bySession,
              [sessionId]: { ...(state.bySession[sessionId] ?? {}), ...scoped },
            },
          };
        }),

      forgetSession: (sessionId) =>
        set((state) => {
          const had = sessionId in state.bySession;
          const droppingActive = state.activeSessionId === sessionId;
          if (!had && !droppingActive) return {};
          const next = { ...state.bySession };
          delete next[sessionId];
          // Drop the pointer too. `bindSession` parks the outgoing tab's live
          // values into `bySession`; if the pointer still names a tab we just
          // forgot, the next bind (activate of the remaining slot) writes it
          // right back — which is how a closed tab's YOLO leaked into a
          // reused id.
          return {
            bySession: next,
            ...(droppingActive ? { activeSessionId: null } : {}),
          };
        }),

      reset: () => set(DEFAULTS as LocalPrefsData),
    }),
    {
      name: 'wrongstack-local-prefs',
      version: 18,
      // v17 (2026-08-26): session-scoped preferences. `bySession` /
      // `sessionDefaults` / `activeSessionId` carry per-tab overrides for the
      // keys in `SESSION_SCOPED_PREFS`; the flat fields stay the EFFECTIVE
      // view of the tab in front, so every existing reader is untouched. Older
      // stores have none of the three and are backfilled by the DEFAULTS
      // spread in `merge`, plus the shape guard below.
      //
      // v16 (2026-08-24): added WrongProxy / WrongTrace toggles. The
      // master switch defaults to off (existing users see no behavior
      // change); the URL defaults to http://localhost:3444 (the dev-script
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
          p.auditLevel = 'full';
        }
        if (typeof p.autoProceedMaxIterations !== 'number') {
          p.autoProceedMaxIterations = 0;
        }
        if (
          !p.fallbackProfiles ||
          typeof p.fallbackProfiles !== 'object' ||
          Array.isArray(p.fallbackProfiles)
        ) {
          p.fallbackProfiles = {};
        }
        if (!Array.isArray(p.favoriteModels)) p.favoriteModels = [];
        if (!Array.isArray(p.disabledModels)) p.disabledModels = [];
        if (!Array.isArray(p.disabledProviders)) p.disabledProviders = [];
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
          p.wrongProxyUrl = 'http://localhost:3444';
        }
        // Telegram poll interval + notification chat. Type-check so a
        // corrupted persisted value (e.g. `"5"`, -3, a NaN poll interval) never
        // reaches the panel or the server's bounded validator, which would
        // reject the whole `prefs.update` payload. The 1–60 range mirrors the
        // server-side NUMBER_PREF_BOUNDS bound; restore the default whenever
        // the stored value is not a usable number in range.
        if (
          typeof p.tgPollIntervalSec !== 'number' ||
          !Number.isFinite(p.tgPollIntervalSec) ||
          p.tgPollIntervalSec < 1 ||
          p.tgPollIntervalSec > 60
        ) {
          p.tgPollIntervalSec = 2;
        }
        if (typeof p.tgChatId !== 'string') p.tgChatId = '';
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
        // Default-on (2026-09): mirrors the plugin's `cfg.enabled !== false`
        // resolver semantics — only absent/invalid values fall back to true;
        // an explicitly persisted false is honored verbatim.
        if (typeof p.autoReviewEnabled !== 'boolean') p.autoReviewEnabled = true;
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
        // Cascade severity threshold: 'off' | 'critical' | 'high' all remain
        // valid persisted values; only absent/invalid input falls back to the
        // default-on 'high' (inclusive threshold).
        if (
          p.autoReviewCascadeOn !== 'off' &&
          p.autoReviewCascadeOn !== 'critical' &&
          p.autoReviewCascadeOn !== 'high'
        ) {
          p.autoReviewCascadeOn = 'high';
        }
        // v11: new boolean flags — backfill with defaults
        if (typeof p.showModelReasoning !== 'boolean') p.showModelReasoning = true;
        // v15: autoCollapseInput — boolean display toggle, default false
        // (input starts expanded; auto-collapse is opt-in).
        if (typeof p.autoCollapseInput !== 'boolean') p.autoCollapseInput = false;
        // chromeLevel — 'calm' | 'full'; anything else (absent, corrupted) is calm.
        if (p.chromeLevel !== 'calm' && p.chromeLevel !== 'full') p.chromeLevel = 'calm';
        if (typeof p.sessionStatsExpanded !== 'boolean') p.sessionStatsExpanded = false;
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
        // v17 shape guards — a hand-edited or truncated store must not turn
        // the override registry into a non-object and take the whole app down
        // on the first tab switch.
        if (typeof p.bySession !== 'object' || p.bySession === null || Array.isArray(p.bySession)) {
          p.bySession = {};
        }
        if (
          typeof p.sessionDefaults !== 'object' ||
          p.sessionDefaults === null ||
          Array.isArray(p.sessionDefaults)
        ) {
          p.sessionDefaults = {};
        }
        if (typeof p.activeSessionId !== 'string') p.activeSessionId = null;

        if (
          typeof p.multiDiffSummaryThreshold !== 'number' ||
          !Number.isFinite(p.multiDiffSummaryThreshold) ||
          p.multiDiffSummaryThreshold < 0
        ) {
          p.multiDiffSummaryThreshold = 5;
        }
        if (typeof p.keyboardShortcuts !== 'boolean') {
          p.keyboardShortcuts = false;
        }
        if (typeof p.memoryCompanionEnabled !== 'boolean') p.memoryCompanionEnabled = true;
        if (typeof p.exploreCompanionEnabled !== 'boolean') p.exploreCompanionEnabled = true;
        if (typeof p.skillCompanionEnabled !== 'boolean') p.skillCompanionEnabled = true;
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
