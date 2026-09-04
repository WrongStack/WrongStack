/**
 * Typed environment-variable parsing helpers.
 *
 * Every `process.env[...]` read in the codebase should go through these
 * helpers so that:
 *
 * 1. Invalid values get a typed fallback instead of `NaN` or an empty string.
 * 2. The fallback is visible at the call site, not buried in a downstream check.
 * 3. Range constraints are expressed at the read site, not scattered.
 *
 * Usage:
 *   ```ts
 *   const idleMs = envInt('WRONGSTACK_IDLE_MS', { default: 30_000, min: 100 });
 *   const enabled = envBool('WRONGSTACK_FEATURE_ENABLED');
 *   const url = envString('WRONGSTACK_BASE_URL');
 *   ```
 */

/**
 * Parse an environment variable as a boolean.
 * Returns `false` for unset, empty, `0`, `false`, `no`, `off` (case-insensitive).
 * Returns `true` for any other non-empty value.
 */
export function envBool(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env || typeof env !== 'object') return false;
  const raw = env[key];
  if (raw === undefined || raw === '') return false;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

/**
 * Parse an environment variable as a boolean, returning `undefined` when unset.
 * Unlike {@link envBool}, this distinguishes "not set" from "set to false".
 */
export function envBoolOptional(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

/**
 * Parse an environment variable as an integer with optional range constraints.
 * Returns `options.default` when unset or unparseable.
 *
 * When `min` or `max` are provided and the parsed value falls outside the
 * range, the default is returned instead of the clamped value — this makes
 * misconfiguration visible (the feature silently runs at the default rather
 * than at an unintended boundary).
 */
export function envInt(
  key: string,
  options: { default: number; min?: number; max?: number } = { default: 0 },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!env || typeof env !== 'object') return options.default;
  const raw = env[key];
  if (raw === undefined || raw === '') return options.default;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return options.default;
  if (options.min !== undefined && parsed < options.min) return options.default;
  if (options.max !== undefined && parsed > options.max) return options.default;
  return parsed;
}

/**
 * Parse an environment variable as a float with optional range constraints.
 * Same semantics as {@link envInt} but for fractional values.
 */
export function envFloat(
  key: string,
  options: { default: number; min?: number; max?: number } = { default: 0 },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!env || typeof env !== 'object') return options.default;
  const raw = env[key];
  if (raw === undefined || raw === '') return options.default;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return options.default;
  if (options.min !== undefined && parsed < options.min) return options.default;
  if (options.max !== undefined && parsed > options.max) return options.default;
  return parsed;
}

/**
 * Read an environment variable as a trimmed string.
 * Returns `undefined` when unset or empty after trimming.
 */
export function envString(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Read an environment variable and validate it against a set of allowed values.
 * Returns `options.default` when unset or when the value is not in the allow-list.
 */
export function envEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  options: { default: T },
  env: NodeJS.ProcessEnv = process.env,
): T {
  const fallback = options?.default;
  if (!Array.isArray(allowed)) return fallback;
  const raw = envString(key, env);
  if (raw === undefined) return fallback;
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}
