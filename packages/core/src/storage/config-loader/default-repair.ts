import { ConfigError, ERROR_CODES } from '../../types/errors.js';
import { CONFIG_BEHAVIOR_DEFAULTS } from './defaults.js';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Add-only default filling: copies missing keys from `defaults` into `target`
 * without removing or replacing any existing values. Recursively fills nested
 * plain objects. Safe for the normal boot path where a user's explicit config
 * must never be overwritten.
 *
 * For the add+replace variant (which also replaces type-incompatible values)
 * see `repairConfigDefaults`.
 */
export function fillMissingDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const value = cloneJsonValue(target);
  const changed = fillMissingDefaultsInPlace(value, defaults);
  return { value, changed };
}

function fillMissingDefaultsInPlace(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = cloneJsonValue(defaultValue);
      changed = true;
      continue;
    }
    const current = target[key];
    if (isPlainRecord(current) && isPlainRecord(defaultValue)) {
      changed = fillMissingDefaultsInPlace(current, defaultValue) || changed;
    }
  }
  return changed;
}

export interface ConfigDefaultRepair {
  path: string;
  action: 'added' | 'replaced';
}

export interface ConfigDefaultRepairReport {
  fixed: Record<string, unknown>;
  changes: ConfigDefaultRepair[];
  changed: boolean;
}

/**
 * Materialize the canonical behavior defaults into a persisted profile config.
 * Add+replace variant: missing fields are added AND values whose JSON shape is
 * incompatible with the default are replaced (not just skipped). This is useful
 * for the config-doctor repair path where a user-edited file may have wrong
 * types. For the normal boot path (add-only) see `fillMissingDefaults`.
 *
 * Identity fields (`provider`, `model`) are intentionally not invented.
 *
 * NOTE: This function assumes JSON-roundtripped input. Non-JSON values such
 * as `Buffer` or `Uint8Array` are objects and may not be correctly detected
 * as type-incompatible with primitive defaults.
 */
export function repairConfigDefaults(input: Record<string, unknown>): ConfigDefaultRepairReport {
  const fixed = cloneJsonValue(input);
  const changes: ConfigDefaultRepair[] = [];

  const MAX_REPAIR_DEPTH = 20;

  const repair = (
    target: Record<string, unknown>,
    defaults: Record<string, unknown>,
    prefix: string,
    depth: number = 0,
  ): void => {
    if (depth > MAX_REPAIR_DEPTH) {
      throw new ConfigError({
        message:
          `Config repair exceeded maximum depth (${MAX_REPAIR_DEPTH}) at "${prefix}". ` +
          'This likely indicates a circular reference or deeply nested user-provided config.',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { depth, prefix },
      });
    }
    for (const [key, defaultValue] of Object.entries(defaults)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!Object.hasOwn(target, key)) {
        target[key] = cloneJsonValue(defaultValue);
        changes.push({ path, action: 'added' });
        continue;
      }

      const current = target[key];
      if (isPlainRecord(defaultValue)) {
        if (isPlainRecord(current)) {
          repair(current, defaultValue, path, depth + 1);
        } else {
          target[key] = cloneJsonValue(defaultValue);
          changes.push({ path, action: 'replaced' });
        }
        continue;
      }

      const defaultIsArray = Array.isArray(defaultValue);
      const defaultIsNumber = typeof defaultValue === 'number';
      // Array element shape is NOT validated here — if an array default's
      // element type changes in a future version, existing arrays with the
      // old element type will be kept even though their elements no longer
      // match the new default element type. This is acceptable because:
      // (a) config changes that widen element types are extremely rare, and
      // (b) the config-doctor is a best-effort repair, not a type checker.
      const compatible = defaultIsArray
        ? Array.isArray(current)
        : defaultIsNumber
          ? typeof current === 'number' && Number.isFinite(current)
          : !Array.isArray(current) && typeof current === typeof defaultValue;
      if (!compatible) {
        target[key] = cloneJsonValue(defaultValue);
        changes.push({ path, action: 'replaced' });
      }
    }
  };

  repair(fixed, CONFIG_BEHAVIOR_DEFAULTS as Record<string, unknown>, '');
  return { fixed, changes, changed: changes.length > 0 };
}
