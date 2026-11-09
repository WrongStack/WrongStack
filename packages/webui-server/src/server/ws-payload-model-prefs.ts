import { acpRuntimeSelectionsError } from '@wrongstack/contracts/types/acp-runtime';
import { FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const REASONING_MODE_VALUES = new Set(['auto', 'on', 'off']);
export const REASONING_EFFORT_VALUES = new Set([
  // WebUI sentinel: "follow the general setting". Valid as a session-scoped
  // pref, but never persisted to Config.modelRuntime (pref-helpers skips it)
  // and never forwarded on the wire (core's withConversationReasoning skips
  // it) — it is not a provider effort level.
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const CACHE_TTL_VALUES = new Set(['default', '5m', '1h']);

export function validateModelRuntimeValue(
  modelRuntime: Record<string, unknown>,
  path: string,
): string | null {
  if (modelRuntime['acp'] !== undefined) {
    const error = acpRuntimeSelectionsError(modelRuntime['acp']);
    if (error) return `${path}.acp: ${error}`;
  }
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

const MODEL_TIER_LEADER_MODE_VALUES = new Set(['off', 'propose', 'auto']);

/** Optional finite number, non-negative unless `min` says otherwise. */
function checkOptionalNumber(
  value: unknown,
  path: string,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${path} must be a finite number when provided`;
  }
  if (value < min || value > max) {
    const maxStr = max === Number.POSITIVE_INFINITY ? '∞' : String(max);
    return `${path} must be in [${min}, ${maxStr}]`;
  }
  return null;
}

/** Optional string field. */
function checkOptionalString(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? null : `${path} must be a string when provided`;
}

/** Validate one `ModelTiersConfig.levels[id]` entry. */
function validateModelTierLevel(level: Record<string, unknown>, path: string): string | null {
  for (const field of ['fallbackProfile', 'provider', 'model', 'description'] as const) {
    const error = checkOptionalString(level[field], `${path}.${field}`);
    if (error) return error;
  }
  // Budgets are ceilings a spawn is clamped to: zero or negative would make
  // every subagent at this tier fail before its first call, so the floor is 1
  // for the count/time budgets and 0 for the spend ceiling (0 = "no spend").
  const numericBounds: Array<[string, number]> = [
    ['maxCostUsd', 0],
    ['maxIterations', 1],
    ['maxToolCalls', 1],
    ['maxTokens', 1],
    ['timeoutMs', 1],
  ];
  for (const [field, min] of numericBounds) {
    const error = checkOptionalNumber(level[field], `${path}.${field}`, min);
    if (error) return error;
  }
  const modelRuntime = level['modelRuntime'];
  if (modelRuntime !== undefined) {
    if (!isRecord(modelRuntime)) return `${path}.modelRuntime must be an object when provided`;
    const error = validateModelRuntimeValue(modelRuntime, `${path}.modelRuntime`);
    if (error) return error;
  }
  return null;
}

/**
 * Validate a `modelTiers` payload against `ModelTiersConfig`.
 *
 * Unknown fields are tolerated (the same contract `modelMatrix` uses): core may
 * grow `ModelTiersConfig`, and a validator that rejects tomorrow's field would
 * reproduce exactly the whole-payload rejection this function exists to fix.
 * What IS enforced is the shape of every field that reaches config, plus the
 * prototype-pollution guard on the two records whose KEYS become property
 * names (`levels` tier ids and `routing` role names) — the same guard
 * `modelMatrix`, `fallbackProfiles` and `pluginsEnabled` already carry.
 */
export function validateModelTiersValue(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;

  const enabled = value['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return `${path}.enabled must be a boolean when provided`;
  }
  const defaultTier = checkOptionalString(value['default'], `${path}.default`);
  if (defaultTier) return defaultTier;

  const levels = value['levels'];
  if (levels !== undefined) {
    if (!isRecord(levels)) return `${path}.levels must be an object when provided`;
    const badLevelKey = Object.keys(levels).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badLevelKey) return `${path}.levels contains a forbidden key: ${badLevelKey}`;
    for (const [id, level] of Object.entries(levels)) {
      if (!isRecord(level)) return `${path}.levels.${id} must be an object`;
      const error = validateModelTierLevel(level, `${path}.levels.${id}`);
      if (error) return error;
    }
  }

  const routing = value['routing'];
  if (routing !== undefined) {
    if (!isRecord(routing)) return `${path}.routing must be an object when provided`;
    const badRouteKey = Object.keys(routing).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badRouteKey) return `${path}.routing contains a forbidden key: ${badRouteKey}`;
    for (const [route, tier] of Object.entries(routing)) {
      if (typeof tier !== 'string') return `${path}.routing.${route} must be a string`;
    }
  }

  const leader = value['leader'];
  if (leader !== undefined) {
    if (!isRecord(leader)) return `${path}.leader must be an object when provided`;
    const mode = leader['mode'];
    if (
      mode !== undefined &&
      (typeof mode !== 'string' || !MODEL_TIER_LEADER_MODE_VALUES.has(mode))
    ) {
      return `${path}.leader.mode must be one of: ${Array.from(MODEL_TIER_LEADER_MODE_VALUES).join(', ')}`;
    }
    const dwell = checkOptionalNumber(leader['dwellTurns'], `${path}.leader.dwellTurns`, 0);
    if (dwell) return dwell;
    const savings = checkOptionalNumber(leader['minSavingsUsd'], `${path}.leader.minSavingsUsd`, 0);
    if (savings) return savings;
    // A context-fill guard is a fraction of the target model's window.
    const fill = checkOptionalNumber(
      leader['maxContextFillForSwitch'],
      `${path}.leader.maxContextFillForSwitch`,
      0,
      1,
    );
    if (fill) return fill;
    const maxTier = checkOptionalString(leader['maxTier'], `${path}.leader.maxTier`);
    if (maxTier) return maxTier;
  }

  return null;
}

/** Validate a single ModelBlackoutRule element. */
export function validateModelBlackoutRule(
  rule: Record<string, unknown>,
  path: string,
): string | null {
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
