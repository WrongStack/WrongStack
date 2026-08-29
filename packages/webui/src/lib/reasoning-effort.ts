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

/**
 * Sentinel for "follow the general (project-wide) setting". Never a wire
 * value: the runtime resolver treats a conversation meta of `auto` as "no
 * conversation-level override", so the global
 * `Config.modelRuntime.reasoning.effort` applies (core's
 * `withConversationReasoning` skips it, and the server never persists it as
 * a concrete effort).
 */
export const AUTO_EFFORT = 'auto';

/** Every value an effort dropdown may offer. */
export type EffortOption = typeof AUTO_EFFORT | Effort;

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
 * Kept OUT of EFFORT_LABEL_KEYS so that Record stays pinned to core's union
 * — `auto` is a WebUI-only sentinel, not a provider vocabulary level.
 */
export const AUTO_EFFORT_LABEL_KEY = 'settings:agent.reasoningEffortAuto';

/** Label key for any option value an effort select renders (auto included). */
export function effortLabelKey(value: EffortOption): string {
  return value === AUTO_EFFORT ? AUTO_EFFORT_LABEL_KEY : EFFORT_LABEL_KEYS[value];
}

/**
 * The effort options to offer for the ACTIVE model.
 *
 * `auto` always leads: it means "this tab follows the general setting"
 * (`Config.modelRuntime.reasoning.effort`), whatever that currently is.
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
): EffortOption[] {
  const narrowed: EffortOption[] = [
    AUTO_EFFORT,
    ...(levels?.length ? (levels.filter(isEffort) as Effort[]) : [...ALL_EFFORTS]),
  ];
  if (isEffort(current) && !narrowed.includes(current)) narrowed.push(current);
  return narrowed;
}

/**
 * True when the persisted effort is KNOWN to be unsupported by the active
 * model — i.e. the model documents an explicit level list and the current
 * value is not in it. Absent levels mean "vocabulary undocumented", which is
 * not evidence of support or its absence; the resolver forwards the value and
 * the UI must not claim it is wrong. `auto` is never "not advertised" — it is
 * not a level at all, it defers to the general setting.
 */
export function effortNotAdvertised(
  levels: readonly string[] | undefined,
  current: string,
): boolean {
  return current !== AUTO_EFFORT && !!levels?.length && !levels.includes(current);
}

/**
 * Tri-state visibility gate, mirroring the resolver's: hide the control only
 * when the model DOCUMENTS that it has no effort control
 * (`reasoningConfig.effortSupported === false`). `undefined` means the
 * vocabulary is undocumented — the resolver forwards the value, so the UI
 * shows the full canonical set rather than claiming support is absent.
 * Boolean-coercing this tri-state is a bug: `undefined` is not `false`.
 */
export function effortControlHidden(effortSupported: boolean | undefined): boolean {
  return effortSupported === false;
}
