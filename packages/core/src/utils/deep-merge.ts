/**
 * Deep merge utility — safely merges nested objects with configurable
 * conflict resolution, array merging, and prototype-pollution guarding.
 *
 * Used by:
 * - config-loader  (config layer merging with primitive-array concatenation)
 * - secret-vault   (config patching)
 * - json-path       (json_merge tool with prefer-base / prefer-patch semantics)
 *
 * @module utils/deep-merge
 */

// ---------------------------------------------------------------------------
// Prototype-pollution guard — shared set of forbidden __proto__ keys
// ---------------------------------------------------------------------------

export const FORBIDDEN_PROTO_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when every element is a primitive or null (no nested objects/arrays). */
export function isPrimitiveArray(a: unknown[]): boolean {
  return a.every((v) => v === null || (typeof v !== 'object' && typeof v !== 'function'));
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepMergeOptions {
  /**
   * Which side wins on collision for scalars and arrays.
   *
   * - `'prefer-patch'` (default): patch value replaces base value.
   * - `'prefer-base'`:  base value is kept, patch value is ignored.
   */
  conflictResolution?: 'prefer-base' | 'prefer-patch';

  /**
   * How to handle array values.
   *
   * - `'replace'` (default): patch array replaces base array entirely.
   * - `'concat-primitives'`: when both values are primitive arrays,
   *   they are concatenated and deduped (via Set).  Non-primitive
   *   arrays still replace the base wholesale.
   */
  arrayMode?: 'replace' | 'concat-primitives';

  /**
   * Skip prototype-pollution keys (`__proto__`, `constructor`, etc.).
   * Enabled by default.  Only disable when you control both inputs
   * and the keyset (e.g. when merging trusted JSON schemas).
   */
  protectProto?: boolean;

  /**
   * Optional callback fired when a non-primitive (object) array is
   * replaced wholesale (only relevant with `arrayMode: 'concat-primitives'`).
   * Receives the key name, existing array length, and patch array length.
   * Used by config-loader for debug logging.
   */
  onNonPrimitiveArrayReplace?: (key: string, existingLen: number, patchLen: number) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Recursively merge `patch` into `base`, returning a new object.
 *
 * - Nested plain objects are merged recursively.
 * - Arrays are handled per `options.arrayMode`.
 * - Scalar collisions are resolved per `options.conflictResolution`.
 * - `null` and non-object values in `patch` replace the base value
 *   (unless `conflictResolution` is `'prefer-base'`).
 * - Keys in `base` that are absent from `patch` are preserved.
 * - `FORBIDDEN_PROTO_KEYS` are skipped in the patch (unless
 *   `options.protectProto` is set to `false`).
 *
 * The function is generic over `T extends Record<string, unknown>` for
 * callers that pass typed config objects, but the runtime signature
 * also accepts `unknown` inputs (used by the json-path plugin).
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
  options?: DeepMergeOptions,
): T;

export function deepMerge(base: unknown, patch: unknown, options?: DeepMergeOptions): unknown;

export function deepMerge(base: unknown, patch: unknown, options: DeepMergeOptions = {}): unknown {
  return deepMergeInternal(base, patch, options, new WeakMap());
}

function deepMergeInternal(
  base: unknown,
  patch: unknown,
  options: DeepMergeOptions,
  seen: WeakMap<object, WeakSet<object>>,
): unknown {
  const {
    conflictResolution = 'prefer-patch',
    arrayMode = 'replace',
    protectProto = true,
    onNonPrimitiveArrayReplace,
  } = options;

  // Non-object / null handling — delegate to conflict resolution.
  if (typeof base !== 'object' || base === null) {
    return conflictResolution === 'prefer-patch' ? patch : base;
  }
  if (typeof patch !== 'object' || patch === null) {
    return conflictResolution === 'prefer-patch' ? patch : base;
  }

  // Arrays — handled *before* the object merge so array-of-objects
  // aren't accidentally treated as plain records.
  if (Array.isArray(base) && Array.isArray(patch)) {
    if (arrayMode === 'concat-primitives' && isPrimitiveArray(base) && isPrimitiveArray(patch)) {
      return [...new Set([...base, ...patch])];
    }
    return conflictResolution === 'prefer-patch' ? patch : base;
  }

  // If only one side is an array, treat as scalar collision.
  if (Array.isArray(base) || Array.isArray(patch)) {
    return conflictResolution === 'prefer-patch' ? patch : base;
  }

  // Plain object merge.
  const baseObj = base as Record<string, unknown>;
  const patchObj = patch as Record<string, unknown>;

  let seenPatches = seen.get(baseObj);
  if (seenPatches?.has(patchObj)) {
    return conflictResolution === 'prefer-patch' ? patchObj : baseObj;
  }
  if (!seenPatches) {
    seenPatches = new WeakSet<object>();
    seen.set(baseObj, seenPatches);
  }
  seenPatches.add(patchObj);

  try {
    const out: Record<string, unknown> = { ...baseObj };

    for (const [k, v] of Object.entries(patchObj)) {
      if (protectProto && FORBIDDEN_PROTO_KEYS.has(k)) continue;

      const existing = out[k];
      if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        // Recursive merge for nested plain objects.
        out[k] = deepMergeInternal(existing, v, options, seen);
      } else if (Array.isArray(v) && Array.isArray(existing)) {
        // Delegate to top-level array handling so arrayMode
        // (e.g. 'concat-primitives') applies to nested arrays too.
        // Fire debug hook when a non-primitive array replaces an existing
        // array (for non-primitive arrays, concat-primitives is a no-op and
        // the result is always a wholesale replacement).
        if (onNonPrimitiveArrayReplace && !isPrimitiveArray(v)) {
          onNonPrimitiveArrayReplace(k, existing.length, v.length);
        }
        out[k] = deepMergeInternal(existing, v, options, seen);
      } else if (v !== undefined) {
        // Fire debug hook when a non-primitive (object) array replaces an
        // existing value in concat-primitives mode.
        if (onNonPrimitiveArrayReplace && Array.isArray(v) && !isPrimitiveArray(v)) {
          const existingLen = Array.isArray(existing) ? existing.length : 0;
          onNonPrimitiveArrayReplace(k, existingLen, v.length);
        }
        // Own keys only: `in` also sees Object.prototype, so a patch key named
        // `valueOf`/`toString` absent from base kept the inherited FUNCTION,
        // which JSON then dropped — the patch value was silently lost.
        out[k] = conflictResolution === 'prefer-base' && Object.hasOwn(baseObj, k) ? existing : v;
      }
      // When v === undefined, leave the existing value untouched
      // (this matches config-loader's behaviour: undefined in patch
      // means "don't change this key").
    }

    return out;
  } finally {
    seenPatches.delete(patchObj);
  }
}
