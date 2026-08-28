import type { ReasoningEffort } from '@wrongstack/core/types';

/**
 * Canonical effort levels. `satisfies` pins this copy to core's
 * `ReasoningEffort` union — adding a level in core without updating this list
 * (or vice versa) becomes a compile error instead of silently dropping the
 * model's newest level from every dropdown.
 */
export const ALL_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

export type Effort = (typeof ALL_EFFORTS)[number];

const EFFORT_SET: ReadonlySet<string> = new Set(ALL_EFFORTS);

/** Guard for server-supplied lists — anything outside the canonical enum
 *  would render a raw key as its label; filter it instead. */
export function isEffort(value: string): value is Effort {
  return EFFORT_SET.has(value);
}

/**
 * i18n keys for every canonical level. Typed against core's full union (not
 * the local `Effort` alias) so the drift guard works in BOTH directions:
 * `satisfies` on ALL_EFFORTS rejects a value core doesn't know, and this
 * Record requires a label key for every value core DOES know — adding a level
 * in core without a label here is a compile error, never a silently-missing
 * dropdown entry.
 */
export const EFFORT_LABEL_KEYS: Record<ReasoningEffort, string> = {
  none: 'settings:agent.reasoningEffortNone',
  minimal: 'settings:agent.reasoningEffortMinimal',
  low: 'settings:agent.reasoningEffortLow',
  medium: 'settings:agent.reasoningEffortMedium',
  high: 'settings:agent.reasoningEffortHigh',
  xhigh: 'settings:agent.reasoningEffortXhigh',
  max: 'settings:agent.reasoningEffortMax',
};

/**
 * The effort options to offer for the ACTIVE model.
 *
 * `levels` is `session.reasoningEffortLevels` — the vocabulary the active
 * model documents (models.dev reasoningConfig, sent only when the catalog
 * lists explicit levels). Undefined/empty means the vocabulary is
 * undocumented, and the full canonical set applies — matching the runtime
 * resolver's conservative gate, which forwards the value whenever
 * `effortSupported !== false` and drops it with a warning otherwise.
 *
 * A persisted effort the model no longer advertises (set on another model)
 * is appended so the user sees what is actually configured and can change it
 * deliberately; the runtime resolver independently omits unsupported values.
 */
export function resolveEffortOptions(
  levels: readonly string[] | undefined,
  current: string,
): Effort[] {
  const narrowed = levels?.length ? (levels.filter(isEffort) as Effort[]) : [...ALL_EFFORTS];
  if (isEffort(current) && !narrowed.includes(current)) narrowed.push(current);
  return narrowed;
}

/**
 * True when the persisted effort is KNOWN to be unsupported by the active
 * model — i.e. the model documents an explicit level list and the current
 * value is not in it. Absent levels mean "vocabulary undocumented", which is
 * not evidence of support or its absence; the resolver forwards the value and
 * the UI must not claim it is wrong.
 */
export function effortNotAdvertised(
  levels: readonly string[] | undefined,
  current: string,
): boolean {
  return !!levels?.length && !levels.includes(current);
}
