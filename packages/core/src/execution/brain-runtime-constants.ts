/**
 * Patch keys that are read per-decision via closures: no chain rebuild needed.
 *
 * These sets are the source of truth for which fields `mergePatch` accepts.
 * Adding a knob to `BrainConfigPatch` without listing it here makes `apply()`
 * throw `Unknown brain config field`, so keep them in step.
 */
export const FAST_PATH_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'maxAutoRisk',
  'humanTimeoutMs',
]);

/** Patch keys whose change requires the tier chain to be reassembled. */
export const STRUCTURAL_PATCH_KEYS: ReadonlySet<string> = new Set([
  'models',
  'strategy',
  'decisionTimeoutMs',
  'council',
  'ledger',
  'rules',
  'heuristics',
  'llm',
  'trace',
  'monitor',
  'terminalPolicy',
  'decisionLogMaxEntries',
  'cache',
]);

/** Every key `mergePatch` accepts. Derived, never hand-maintained. */
export const KNOWN_PATCH_KEYS: ReadonlySet<string> = new Set([
  ...FAST_PATH_KEYS,
  ...STRUCTURAL_PATCH_KEYS,
]);

export const AUTO_RISK_LEVELS: ReadonlySet<string> = new Set([
  'off',
  'low',
  'medium',
  'high',
  'all',
]);
export const COUNCIL_MIN_RISKS: ReadonlySet<string> = new Set(['medium', 'high', 'critical']);
export const COUNCIL_DISTINCTNESS: ReadonlySet<string> = new Set(['none', 'model', 'provider']);
export const TRACE_CONTENT_MODES: ReadonlySet<string> = new Set(['none', 'redacted', 'full']);
export const DENY_TERMINAL_MODES: ReadonlySet<string> = new Set([
  'never',
  'when-decided',
  'always',
]);
export const TERMINAL_POLICIES: ReadonlySet<string> = new Set([
  'conservative',
  'deny-all',
  'continue-on-recommended',
]);
