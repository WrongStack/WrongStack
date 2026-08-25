import { FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';

type PayloadValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PrefsUpdatePayload {
  prefs: Record<string, unknown>;
}

const AUTONOMY_VALUES = new Set(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel']);
const CONTEXT_STRATEGY_VALUES = new Set(['hybrid', 'intelligent', 'selective']);
const CONTEXT_MODE_VALUES = new Set(['balanced', 'frugal', 'deep']);
const TOKEN_SAVING_TIER_VALUES = new Set([
  'auto',
  'off',
  'minimal',
  'light',
  'medium',
  'aggressive',
]);
const ENHANCE_LANGUAGE_VALUES = new Set(['original', 'english']);
const LOG_LEVEL_VALUES = new Set(['debug', 'info', 'warn', 'error']);
const AUDIT_LEVEL_VALUES = new Set(['minimal', 'standard', 'full']);
const REASONING_MODE_VALUES = new Set(['auto', 'on', 'off']);
const REASONING_EFFORT_VALUES = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const CACHE_TTL_VALUES = new Set(['default', '5m', '1h']);
/** Identity-prompt variants offered by the system-prompt picker. */
const SYSTEM_PROMPT_VARIANT_VALUES = new Set(['lite', 'default', 'pro']);

const BOOLEAN_PREF_KEYS = new Set([
  'yolo',
  'chime',
  'confirmExit',
  'nextPrediction',
  'nextStepsTool',
  'titleAnimation',
  'enhanceEnabled',
  'featureMcp',
  'featurePlugins',
  'featureMemory',
  'featureSkills',
  'featureModelsRegistry',
  'indexOnStart',
  'contextAutoCompact',
  'tgSessionEnd',
  'tgDelegate',
  'reasoningPreserve',
  'hqEnabled',
  'hqRawContent',
  'fallbackAuto',
  'favoriteModelsOnly',
  'breakerEnabled',
  'debugStream',
  // Chimera + auto-review master toggles
  'chimeraEnabled',
  'autoReviewEnabled',
  'showModelReasoning',
  // Display-only toggles (purely visual, persisted in localStorage via Zustand).
  'groupToolCalls',
  'showThinkingLogs',
  // v15: auto-collapse of the chat input under the history (opt-in display
  // toggle, default off). Whitelisted so the key survives `prefs.update`
  // round-trips without tripping the "unknown preference key" rejection.
  'autoCollapseInput',
  // v11 Display parity: inverse fsAccess flag.
  'allowOutsideProjectRoot',
  // v13 Display parity (TUI SettingsPicker fields 42 & 43): the read tool
  // includes codebase-index symbols, and SAGE memory-inject blocks are
  // surfaced in tool results. Both are pure WebUI-display toggles mirrored
  // against the TUI's settings picker; the server mirrors them through
  // `prefs.update` exactly so the panel does not error with
  // "unknown preference key".
  'readSymbols',
  'showSageMemoryInject',
  // WrongProxy / WrongTrace master switch. When on, the CLI rewrites every
  // provider's base URL through the configured proxy URL (default
  // http://localhost:3444 → http://localhost:3444/proxy/<host><path>).
  // Excluded providers (openai-codex) flow through unchanged.
  'wrongProxyEnabled',
]);

/** Keys whose value must be an array of strings (e.g. an ordered model list). */
const STRING_ARRAY_PREF_KEYS = new Set([
  'fallbackModels',
  'favoriteModels',
  // Auto-review explicit fallback chain (derived when fallbackProfile is unset;
  // surfaced for visibility/override).
  'autoReviewFallbackModels',
]);
const STRING_ARRAY_RECORD_PREF_KEYS = new Set(['fallbackProfiles']);
/** Map of array-typed pref keys to their element-level validator. */
const ARRAY_PREF_VALIDATORS: Record<
  string,
  (item: Record<string, unknown>, path: string) => string | null
> = {
  modelAvailabilitySchedule: validateModelBlackoutRule,
};
const MODEL_MATRIX_PREF_KEYS = new Set(['modelMatrix']);
// Object of booleans, e.g. { 'plugin-name': true }. Parity with the embedded
// server, which accepts `pluginsEnabled` and persists it to
// extensions.<name>.enabled — the standalone server rejected it as unknown.
const BOOLEAN_RECORD_PREF_KEYS = new Set(['pluginsEnabled']);

const NUMBER_PREF_KEYS = new Set([
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'maxIterations',
  'maxConcurrent',
  'enhanceDelayMs',
  'enhanceCountdownMs',
  'tgLongToolMs',
  'breakerAutoKillResetMs',
  // Chimera + auto-review numeric knobs
  'chimeraMaxFiles',
  'autoReviewDebounceMs',
  'autoReviewMaxFilesPerBatch',
  'autoReviewMaxConcurrentReviews',
  // v13 Display parity (TUI SettingsPicker fields 41, 44, 21): the
  // pre-refine grace countdown (seconds), the SAGE memory-inject relation
  // floor (0..1), and the minimum file count for the multi-diff summary
  // footer. All three are driven by the WebUI sliders in DisplaySection
  // and previously tripped the "unknown preference key" rejection.
  'preRefineSeconds',
  'sageMemoryInjectThreshold',
  'multiDiffSummaryThreshold',
]);

/**
 * Per-key inclusive min/max bounds for `NUMBER_PREF_KEYS`. Entries absent
 * from this map fall back to the generic "must be a finite number" rule
 * (preserving the original behaviour for ms timings and similar). Keys
 * listed here get an extra bounds check that fires *before* the value is
 * handed to the persist layer; bounds are aligned with the validation
 * that `pref-helpers.ts` already applies to chimera / auto-review
 * extensions (`>= 1` for `maxFiles`) so out-of-range values like
 * `maxIterations: -5` or `maxConcurrent: 0` are rejected loudly instead
 * of silently landing in `config.tools` / `config.maxConcurrent`.
 */
const NUMBER_PREF_BOUNDS: Record<string, { min: number; max: number }> = {
  // Iteration / concurrency — must be at least 1 to make progress.
  maxIterations: { min: 1, max: Number.POSITIVE_INFINITY },
  maxConcurrent: { min: 1, max: Number.POSITIVE_INFINITY },
  autoProceedMaxIterations: { min: 1, max: Number.POSITIVE_INFINITY },
  chimeraMaxFiles: { min: 1, max: Number.POSITIVE_INFINITY },
  autoReviewMaxFilesPerBatch: { min: 1, max: Number.POSITIVE_INFINITY },
  autoReviewMaxConcurrentReviews: { min: 1, max: Number.POSITIVE_INFINITY },
  // Counts (must be >= 1 to render a footer at all).
  multiDiffSummaryThreshold: { min: 1, max: Number.POSITIVE_INFINITY },
  preRefineSeconds: { min: 0, max: Number.POSITIVE_INFINITY },
  // Probability — must lie in [0, 1].
  sageMemoryInjectThreshold: { min: 0, max: 1 },
  // Debounce / delay — non-negative ms.
  autoReviewDebounceMs: { min: 0, max: Number.POSITIVE_INFINITY },
};

const STRING_PREF_KEYS = new Set([
  'hqUrl',
  'hqToken',
  'uiLocale',
  'thinkingWord',
  'refinerProvider',
  'refinerModel',
  'refinerFallbackProfile',
  // Chimera + auto-review override strings
  'chimeraProvider',
  'chimeraModel',
  'autoReviewProvider',
  'autoReviewModel',
  'autoReviewFallbackProfile',
  // WrongProxy / WrongTrace URL. Empty = unset. Default lives in
  // `LocalPrefs.DEFAULTS.wrongProxyUrl` ('http://localhost:3444'); users
  // can override here for non-default daemon ports / paths.
  'wrongProxyUrl',
]);

const ENUM_PREF_KEYS: Record<string, Set<string>> = {
  autonomy: AUTONOMY_VALUES,
  contextStrategy: CONTEXT_STRATEGY_VALUES,
  contextMode: CONTEXT_MODE_VALUES,
  tokenSavingTier: TOKEN_SAVING_TIER_VALUES,
  systemPromptVariant: SYSTEM_PROMPT_VARIANT_VALUES,
  enhanceLanguage: ENHANCE_LANGUAGE_VALUES,
  logLevel: LOG_LEVEL_VALUES,
  auditLevel: AUDIT_LEVEL_VALUES,
  reasoningMode: REASONING_MODE_VALUES,
  reasoningEffort: REASONING_EFFORT_VALUES,
  cacheTtl: CACHE_TTL_VALUES,
  statuslineMode: new Set(['minimum', 'detailed', 'no-color']),
  animationStyle: new Set(['rainbow', 'wave', 'pulse', 'dots', 'breathe', 'static', 'cycle']),
  fsAccess: new Set(['unrestricted', 'project']),
  // Chimera autoFix + auto-review cascade threshold
  chimeraAutoFix: new Set(['off', 'ask', 'auto']),
  autoReviewModelSelection: new Set(['round-robin', 'random']),
  autoReviewCascadeOn: new Set(['off', 'critical', 'high']),
  fleetChatVerbosity: new Set(['off', 'full']),
  showAgentSwarmPanel: new Set(['bottom', 'sidebar', 'off']),
};

function validateModelRuntimeValue(
  modelRuntime: Record<string, unknown>,
  path: string,
): string | null {
  const reasoning = modelRuntime['reasoning'];
  if (reasoning !== undefined) {
    if (!isRecord(reasoning)) return `${path}.reasoning must be an object when provided`;
    const mode = reasoning['mode'];
    const effort = reasoning['effort'];
    const preserve = reasoning['preserve'];
    if (mode !== undefined && (typeof mode !== 'string' || !REASONING_MODE_VALUES.has(mode))) {
      return `${path}.reasoning.mode must be one of: ${Array.from(REASONING_MODE_VALUES).join(', ')}`;
    }
    if (
      effort !== undefined &&
      (typeof effort !== 'string' || !REASONING_EFFORT_VALUES.has(effort))
    ) {
      return `${path}.reasoning.effort must be one of: ${Array.from(REASONING_EFFORT_VALUES).join(', ')}`;
    }
    if (preserve !== undefined && typeof preserve !== 'boolean') {
      return `${path}.reasoning.preserve must be a boolean when provided`;
    }
  }

  const cache = modelRuntime['cache'];
  if (cache !== undefined) {
    if (!isRecord(cache)) return `${path}.cache must be an object when provided`;
    const ttl = cache['ttl'];
    if (
      ttl !== undefined &&
      (typeof ttl !== 'string' || !CACHE_TTL_VALUES.has(ttl) || ttl === 'default')
    ) {
      return `${path}.cache.ttl must be one of: 5m, 1h`;
    }
  }

  const parameters = modelRuntime['parameters'];
  if (parameters !== undefined && !isRecord(parameters)) {
    return `${path}.parameters must be an object when provided`;
  }

  return null;
}

/** Validate a single ModelBlackoutRule element. */
function validateModelBlackoutRule(rule: Record<string, unknown>, path: string): string | null {
  const id = rule['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return `${path}.id must be a non-empty string`;
  }
  const start = rule['start'];
  if (typeof start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) {
    return `${path}.start must be a string in HH:mm (00:00-23:59) format`;
  }
  const end = rule['end'];
  if (typeof end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    return `${path}.end must be a string in HH:mm (00:00-23:59) format`;
  }
  // start >= end is valid: it means the rule crosses midnight (overnight).
  // e.g., start=22:00, end=06:00 blocks from 10 PM to 6 AM the next day.
  // (if the caller intends same-day scheduling they must ensure start < end).
  if (rule['enabled'] !== undefined && typeof rule['enabled'] !== 'boolean') {
    return `${path}.enabled must be a boolean when provided`;
  }
  if (rule['provider'] !== undefined && typeof rule['provider'] !== 'string') {
    return `${path}.provider must be a string when provided`;
  }
  if (rule['model'] !== undefined && typeof rule['model'] !== 'string') {
    return `${path}.model must be a string when provided`;
  }
  if (rule['days'] !== undefined) {
    if (!Array.isArray(rule['days'])) return `${path}.days must be an array when provided`;
    const seen = new Set<number>();
    for (const d of rule['days']) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
        return `${path}.days elements must be integers 0-6 when provided`;
      }
      if (seen.has(d)) return `${path}.days contains duplicate day: ${d}`;
      seen.add(d);
    }
  }
  if (rule['timezone'] !== undefined) {
    if (typeof rule['timezone'] !== 'string') {
      return `${path}.timezone must be a string when provided`;
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: rule['timezone'] as string });
    } catch {
      return `${path}.timezone is not a valid IANA timezone (e.g. "America/New_York")`;
    }
  }
  if (rule['label'] !== undefined && typeof rule['label'] !== 'string') {
    return `${path}.label must be a string when provided`;
  }
  if (rule['mode'] !== undefined && rule['mode'] !== 'blackout' && rule['mode'] !== 'allow_only') {
    return `${path}.mode must be 'blackout' or 'allow_only' when provided`;
  }
  return null;
}

function validatePreferenceValue(key: string, value: unknown): string | null {
  if (BOOLEAN_PREF_KEYS.has(key)) {
    return typeof value === 'boolean' ? null : `prefs.update payload.${key} must be a boolean`;
  }
  if (NUMBER_PREF_KEYS.has(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `prefs.update payload.${key} must be a finite number`;
    }
    const bounds = NUMBER_PREF_BOUNDS[key];
    if (bounds && (value < bounds.min || value > bounds.max)) {
      const maxStr = bounds.max === Number.POSITIVE_INFINITY ? '∞' : String(bounds.max);
      return `prefs.update payload.${key} must be in [${bounds.min}, ${maxStr}]`;
    }
    return null;
  }
  if (STRING_PREF_KEYS.has(key)) {
    return typeof value === 'string' ? null : `prefs.update payload.${key} must be a string`;
  }
  if (STRING_ARRAY_PREF_KEYS.has(key)) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? null
      : `prefs.update payload.${key} must be an array of strings`;
  }
  const arrayValidator = ARRAY_PREF_VALIDATORS[key];
  if (arrayValidator) {
    if (!Array.isArray(value)) return `prefs.update payload.${key} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (!isRecord(item)) return `prefs.update payload.${key}[${i}] must be an object`;
      const error = arrayValidator(item, `prefs.update payload.${key}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (STRING_ARRAY_RECORD_PREF_KEYS.has(key)) {
    if (
      !isRecord(value) ||
      !Object.values(value).every(
        (v) => Array.isArray(v) && v.every((item) => typeof item === 'string'),
      )
    ) {
      return `prefs.update payload.${key} must be an object of string arrays`;
    }
    // The KEYS here become profile names that get assigned directly into
    // `config.fallbackProfiles` (see `pref-helpers.ts:298`), so a payload
    // like `{ "__proto__": ["x"] }` would otherwise reach the persist
    // layer and pollute Object.prototype. Mirror the
    // `BOOLEAN_RECORD_PREF_KEYS` guard above for parity.
    const badKey = Object.keys(value).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badKey) {
      return `prefs.update payload.${key} contains a forbidden key: ${badKey}`;
    }
    return null;
  }
  if (BOOLEAN_RECORD_PREF_KEYS.has(key)) {
    if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'boolean')) {
      return `prefs.update payload.${key} must be an object of booleans`;
    }
    // The KEYS here are plugin names that get used as property keys downstream
    // (extensions.<name>.enabled), so they must be checked too — validating
    // only the values let `{"__proto__": true}` through to a write that
    // polluted Object.prototype. The persist layer guards as well; this
    // rejects loudly instead of silently dropping the entry.
    const badKey = Object.keys(value).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badKey) {
      return `prefs.update payload.${key} contains a forbidden key: ${badKey}`;
    }
    return null;
  }
  if (MODEL_MATRIX_PREF_KEYS.has(key)) {
    if (!isRecord(value)) return `prefs.update payload.${key} must be an object`;
    // Role-name keys become property keys on `config.modelMatrix`
    // (`pref-helpers.ts:311`), so guard against prototype-pollution keys
    // the same way `BOOLEAN_RECORD_PREF_KEYS` and `STRING_ARRAY_RECORD_PREF_KEYS`
    // do. Validate keys first so a polluted entry doesn't leak past the
    // per-entry shape checks before we reject it.
    const badMatrixKey = Object.keys(value).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badMatrixKey) {
      return `prefs.update payload.${key} contains a forbidden key: ${badMatrixKey}`;
    }
    for (const entry of Object.values(value)) {
      if (!isRecord(entry)) return `prefs.update payload.${key} entries must be objects`;
      const provider = entry['provider'];
      const model = entry['model'];
      const fallbackProfile = entry['fallbackProfile'];
      const modelRuntime = entry['modelRuntime'];
      if (provider !== undefined && typeof provider !== 'string') {
        return `prefs.update payload.${key}.provider must be a string when provided`;
      }
      if (model !== undefined && typeof model !== 'string') {
        return `prefs.update payload.${key}.model must be a string when provided`;
      }
      if (fallbackProfile !== undefined && typeof fallbackProfile !== 'string') {
        return `prefs.update payload.${key}.fallbackProfile must be a string when provided`;
      }
      if (modelRuntime !== undefined && !isRecord(modelRuntime)) {
        return `prefs.update payload.${key}.modelRuntime must be an object when provided`;
      }
      if (isRecord(modelRuntime)) {
        const runtimeError = validateModelRuntimeValue(
          modelRuntime,
          `prefs.update payload.${key}.modelRuntime`,
        );
        if (runtimeError) return runtimeError;
      }
      if (model === undefined && fallbackProfile === undefined && modelRuntime === undefined) {
        return `prefs.update payload.${key} entries require model, fallbackProfile, or modelRuntime`;
      }
    }
    return null;
  }
  const allowed = ENUM_PREF_KEYS[key];
  if (allowed) {
    return typeof value === 'string' && allowed.has(value)
      ? null
      : `prefs.update payload.${key} must be one of: ${Array.from(allowed).join(', ')}`;
  }
  return `prefs.update payload contains unknown preference key: ${key}`;
}

export function validatePrefsUpdatePayload(
  payload: unknown,
): PayloadValidationResult<PrefsUpdatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'prefs.update payload must be an object' };
  }
  for (const [key, value] of Object.entries(payload)) {
    const error = validatePreferenceValue(key, value);
    if (error) return { ok: false, message: error };
  }
  return { ok: true, value: { prefs: payload } };
}
