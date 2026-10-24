import {
  LIMITS_BUDGET_KEYS,
  LIMITS_SCALAR_KEYS,
  type LimitsBudgetKey,
  type LimitsScalarKey,
  limitValueError,
} from '@wrongstack/contracts/types';
import { FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';
import {
  CACHE_TTL_VALUES,
  isRecord,
  REASONING_EFFORT_VALUES,
  REASONING_MODE_VALUES,
  validateModelBlackoutRule,
  validateModelRuntimeValue,
  validateModelTiersValue,
} from './ws-payload-model-prefs.js';

type PayloadValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

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
/** Identity-prompt variants offered by the system-prompt picker. */
const SYSTEM_PROMPT_VARIANT_VALUES = new Set(['lite', 'default', 'pro', 'scout']);

const BOOLEAN_PREF_KEYS = new Set([
  'subagentsAllowed',
  'subagentCompanionsAllowed',
  'yolo',
  'yoloPlus',
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
  'featureToolCoach',
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
  'keyboardShortcuts',
  // v16 SimpleUI display parity: tab-strip presence (running marker + unread
  // mailbox prefix in document.title). Pure browser display toggle with no
  // TUI counterpart — accepted here so the key survives `prefs.update`
  // round-trips without tripping the "unknown preference key" rejection.
  'showTabTitle',
]);

/** Keys whose value must be an array of strings (e.g. an ordered model list). */
const STRING_ARRAY_PREF_KEYS = new Set([
  'fallbackModels',
  'favoriteModels',
  'disabledModels',
  'disabledProviders',
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
/**
 * Session-scoped subagent model plan (`coordination/session-subagent-models`).
 * Shape-checked here only enough to reject junk; core's
 * `normalizeSubagentModelPlan` is the canonical coercion and runs on the way
 * into the registry, so unknown extra fields are tolerated on purpose.
 */
const SUBAGENT_MODEL_PLAN_PREF_KEYS = new Set(['subagentModelPlan']);
/**
 * Deterministic cost tiers (`Config.modelTiers`).
 *
 * This key was in `pref-helpers.ts`'s PREF_KEYS — the persist half was written
 * and ready — but never in any validator set, so `validatePreferenceValue`
 * fell through to "unknown preference key" and rejected the WHOLE payload.
 * The WebUI's Model Tiers editor (`SettingsPanel/ModelTiersSection.tsx`) writes
 * the entire object through `syncPref` on every keystroke, so the local store
 * updated, the panel re-rendered, and the config file never changed — the
 * setting looked applied while `/tier` and the TUI menu showed the old value.
 * See docs/archive/local/audit/webui-full-review-2026-09-03.md B-01.
 */
const MODEL_TIERS_PREF_KEYS = new Set(['modelTiers']);
/** User-chosen limits (`Config.limits`); sent whole, unset fields = no limit. */
const LIMITS_PREF_KEYS = new Set(['limits']);
const LIMITS_SCALAR_FIELDS: ReadonlySet<string> = new Set(LIMITS_SCALAR_KEYS);
const LIMITS_BUDGET_FIELDS: ReadonlySet<string> = new Set(LIMITS_BUDGET_KEYS);

/**
 * Validate a `limits` payload: known fields only, each a whole number inside
 * its `LIMIT_BOUNDS` range (the same table the CLI and the browser use).
 */
function validateLimitsValue(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const [field, v] of Object.entries(value)) {
    if (field === 'subagentDefaultBudget') {
      if (v === undefined) continue;
      if (!isRecord(v)) return `${path}.subagentDefaultBudget must be an object`;
      for (const [bf, bv] of Object.entries(v)) {
        if (!LIMITS_BUDGET_FIELDS.has(bf)) {
          return `${path}.subagentDefaultBudget has unknown field: ${bf}`;
        }
        const error = limitValueError(bf as LimitsBudgetKey, bv);
        if (error) return `${path}.subagentDefaultBudget.${bf} ${error}`;
      }
      continue;
    }
    if (!LIMITS_SCALAR_FIELDS.has(field)) return `${path} has unknown field: ${field}`;
    const error = limitValueError(field as LimitsScalarKey, v);
    if (error) return `${path}.${field} ${error}`;
  }
  return null;
}
// Object of booleans, e.g. { 'plugin-name': true }. Parity with the embedded
// server, which accepts `pluginsEnabled` and persists it to
// extensions.<name>.enabled — the standalone server rejected it as unknown.
const BOOLEAN_RECORD_PREF_KEYS = new Set(['pluginsEnabled', 'yoloConfirm']);

const NUMBER_PREF_KEYS = new Set([
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'maxIterations',
  'maxConcurrent',
  'enhanceDelayMs',
  'enhanceCountdownMs',
  'tgLongToolMs',
  // Telegram polling interval (seconds). Same 1–60 bound the CLI's
  // `/telegram-settings poll` enforces and `telegramConfigSchema` declares.
  'tgPollIntervalSec',
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

const MAX_TIMER_MS = 2 ** 31 - 1;

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
const NUMBER_PREF_BOUNDS: Record<string, { min: number; max: number; integer?: boolean }> = {
  // Iteration / concurrency — maxIterations 0 = unlimited (the core default);
  // maxConcurrent must be at least 1 to make progress.
  maxIterations: { min: 0, max: Number.POSITIVE_INFINITY },
  maxConcurrent: { min: 1, max: Number.POSITIVE_INFINITY },
  autoProceedMaxIterations: { min: 0, max: Number.POSITIVE_INFINITY },
  chimeraMaxFiles: { min: 1, max: Number.POSITIVE_INFINITY },
  autoReviewMaxFilesPerBatch: { min: 1, max: Number.POSITIVE_INFINITY },
  autoReviewMaxConcurrentReviews: { min: 1, max: Number.POSITIVE_INFINITY },
  // Counts (0 disables footer).
  multiDiffSummaryThreshold: { min: 0, max: Number.POSITIVE_INFINITY },
  preRefineSeconds: { min: 0, max: Number.POSITIVE_INFINITY },
  // Probability — must lie in [0, 1].
  sageMemoryInjectThreshold: { min: 0, max: 1 },
  // Telegram polling interval, in seconds. Same 1–60 range the CLI
  // (`/telegram-settings poll`) and telegramConfigSchema both enforce, so a
  // 0 or 61 is rejected here rather than persisted and then ignored.
  // `integer` because the bounds alone would let 2.9 through: the CLI rejects
  // it ("Invalid value") and the plugin's JSON schema declares
  // `type: 'integer'`, so persisting a fractional interval would write a value
  // the Telegram config reader treats as out-of-schema.
  tgPollIntervalSec: { min: 1, max: 60, integer: true },
  // Debounce / delay — non-negative ms that a Node timer can hold: past
  // 2^31-1 Node fires after 1 ms, so a "practically never" breaker reset
  // (35 days) killed every process the moment the breaker tripped.
  autoReviewDebounceMs: { min: 0, max: MAX_TIMER_MS },
  autonomyDelayMs: { min: 0, max: MAX_TIMER_MS },
  enhanceDelayMs: { min: 0, max: MAX_TIMER_MS },
  enhanceCountdownMs: { min: 0, max: MAX_TIMER_MS },
  tgLongToolMs: { min: 0, max: MAX_TIMER_MS },
  breakerAutoKillResetMs: { min: 0, max: MAX_TIMER_MS },
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

/**
 * Telegram default notification chat (`Config.extensions.telegram.notifyChatId`).
 *
 * Not a plain string: the CLI's `/telegram-settings chat` accepts a numeric
 * Telegram ID only, and `classifyTelegramChatId`
 * (packages/cli/src/slash-commands/telegram-setup.ts) splits it on sign —
 * positive = private chat, negative = group/supergroup/channel. Groups are an
 * outbound-broadcast target, so the CLI refuses them unless
 * `extensions.telegram.allowGroupChats` is explicitly true.
 *
 * The same classification is re-implemented here rather than imported:
 * `@wrongstack/webui-server` does not depend on `@wrongstack/telegram` or the
 * CLI package, and this module is on the hot path for every `prefs.update`
 * frame. `tests/telegram-prefs.test.ts` pins the parity.
 */
const TELEGRAM_CHAT_ID_PREF_KEYS = new Set(['tgChatId']);

/**
 * Validate a Telegram chat ID exactly as the CLI does: a non-zero safe integer.
 * An empty string clears the target (the CLI has no clear verb, but the WebUI
 * input is editable, so clearing must be expressible).
 */
function validateTelegramChatId(value: unknown, path: string): string | null {
  if (typeof value !== 'string') return `${path} must be a string`;
  const normalized = value.trim();
  if (normalized === '') return null;
  if (!/^-?\d+$/.test(normalized)) return `${path} must be a Telegram chat ID (integer)`;
  const chatId = Number(normalized);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    return `${path} must be a non-zero chat ID`;
  }
  return null;
}

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
  nextStepsMode: new Set(['optional', 'required']),
  showAgentSwarmPanel: new Set(['bottom', 'sidebar', 'off']),
};

function validatePreferenceValue(key: string, value: unknown): string | null {
  if (BOOLEAN_PREF_KEYS.has(key)) {
    return typeof value === 'boolean' ? null : `prefs.update payload.${key} must be a boolean`;
  }
  if (NUMBER_PREF_KEYS.has(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `prefs.update payload.${key} must be a finite number`;
    }
    const bounds = NUMBER_PREF_BOUNDS[key];
    if (bounds) {
      if (value < bounds.min || value > bounds.max) {
        const maxStr = bounds.max === Number.POSITIVE_INFINITY ? '∞' : String(bounds.max);
        return `prefs.update payload.${key} must be in [${bounds.min}, ${maxStr}]`;
      }
      if (bounds.integer && !Number.isInteger(value)) {
        return `prefs.update payload.${key} must be an integer`;
      }
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
  if (SUBAGENT_MODEL_PLAN_PREF_KEYS.has(key)) {
    if (!isRecord(value)) return `prefs.update payload.${key} must be an object`;
    const slots = value['slots'];
    if (slots !== undefined && !Array.isArray(slots)) {
      return `prefs.update payload.${key}.slots must be an array when provided`;
    }
    if (Array.isArray(slots) && slots.some((slot) => slot !== null && !isRecord(slot))) {
      return `prefs.update payload.${key}.slots entries must be objects`;
    }
    const roles = value['roles'];
    if (roles !== undefined && !isRecord(roles)) {
      return `prefs.update payload.${key}.roles must be an object when provided`;
    }
    if (isRecord(roles)) {
      // Role names become property keys on the plan, so reject the pollution
      // keys the matrix/record validators already guard against.
      const badRoleKey = Object.keys(roles).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
      if (badRoleKey) {
        return `prefs.update payload.${key} contains a forbidden key: ${badRoleKey}`;
      }
    }
    for (const flag of ['enabled', 'lock'] as const) {
      const flagValue = value[flag];
      if (flagValue !== undefined && typeof flagValue !== 'boolean') {
        return `prefs.update payload.${key}.${flag} must be a boolean when provided`;
      }
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
  if (MODEL_TIERS_PREF_KEYS.has(key)) {
    return validateModelTiersValue(value, `prefs.update payload.${key}`);
  }
  if (LIMITS_PREF_KEYS.has(key)) {
    return validateLimitsValue(value, `prefs.update payload.${key}`);
  }
  if (TELEGRAM_CHAT_ID_PREF_KEYS.has(key)) {
    return validateTelegramChatId(value, `prefs.update payload.${key}`);
  }
  const allowed = ENUM_PREF_KEYS[key];
  if (allowed) {
    return typeof value === 'string' && allowed.has(value)
      ? null
      : `prefs.update payload.${key} must be one of: ${Array.from(allowed).join(', ')}`;
  }
  return `prefs.update payload contains unknown preference key: ${key}`;
}

/**
 * Every preference key `validatePreferenceValue` will accept.
 *
 * Exported so the drift between this validator and `pref-helpers.ts`'s
 * `PREF_KEYS` (the keys the server is prepared to READ and PERSIST) can be
 * asserted instead of remembered. The two lists disagreeing is silent and
 * asymmetric, and both directions are bugs a user sees:
 *
 *   - persistable but NOT validated: the whole `prefs.update` payload is
 *     rejected on that one key, so the browser's local store updates, the
 *     panel re-renders, and the config file never changes — the setting looks
 *     applied and is not (this is exactly how `modelTiers` shipped broken);
 *   - validated but NOT persistable: the write is accepted, echoed back, and
 *     silently dropped at the persist layer, so it survives until reload.
 *
 * Assembled from the same sets `validatePreferenceValue` consults, in the same
 * order, so a new key can only reach the validator by also reaching this set.
 */
export const VALIDATED_PREF_KEYS: ReadonlySet<string> = new Set<string>([
  ...BOOLEAN_PREF_KEYS,
  ...NUMBER_PREF_KEYS,
  ...STRING_PREF_KEYS,
  ...STRING_ARRAY_PREF_KEYS,
  ...Object.keys(ARRAY_PREF_VALIDATORS),
  ...STRING_ARRAY_RECORD_PREF_KEYS,
  ...BOOLEAN_RECORD_PREF_KEYS,
  ...MODEL_MATRIX_PREF_KEYS,
  ...MODEL_TIERS_PREF_KEYS,
  ...LIMITS_PREF_KEYS,
  ...SUBAGENT_MODEL_PLAN_PREF_KEYS,
  ...TELEGRAM_CHAT_ID_PREF_KEYS,
  ...Object.keys(ENUM_PREF_KEYS),
]);

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
