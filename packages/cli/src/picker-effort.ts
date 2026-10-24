/**
 * Reasoning-effort strip for the STARTUP model picker — the pre-TUI twin of
 * the `/model` picker's ←/→ strip (tui/components/model-picker-effort.ts).
 *
 * The vocabulary is model-aware the same way: a model whose catalog entry
 * documents its levels offers only those, an undocumented reasoner offers the
 * full canonical set (the runtime resolver drops what the wire cannot carry),
 * and a non-reasoning model — or one documented as having no effort control —
 * offers nothing. The list is always led by {@link EFFORT_KEEP}, so pressing
 * Enter without touching ←/→ keeps the configured effort exactly as before.
 */
import {
  type ModelsDevModel,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@wrongstack/contracts/types';

/** Sentinel first option: leave the persisted reasoning effort untouched. */
export const EFFORT_KEEP = 'default';

export type StartupEffortChoice = typeof EFFORT_KEEP | ReasoningEffort;

/** Effort choices for one model, weakest → strongest, led by `default`. */
export function startupEffortOptions(
  model: Pick<ModelsDevModel, 'reasoning' | 'reasoningConfig'> | undefined,
): readonly StartupEffortChoice[] {
  if (!model) return [];
  const config = model.reasoningConfig;
  if (!(model.reasoning ?? config !== undefined)) return [];
  if (config?.effortSupported === false) return [];
  const documented = config?.effortSupported ? (config.effortLevels ?? []) : [];
  const levels =
    documented.length > 0
      ? REASONING_EFFORT_LEVELS.filter((level) => documented.includes(level))
      : [...REASONING_EFFORT_LEVELS];
  if (levels.length === 0) return [];
  return [EFFORT_KEEP, ...levels];
}

/** Cycle the current choice by `delta`, wrapping around the list. */
export function cycleStartupEffort(
  options: readonly StartupEffortChoice[],
  current: string,
  delta: number,
): StartupEffortChoice {
  if (options.length === 0) return EFFORT_KEEP;
  const base = Math.max(0, options.indexOf(current as StartupEffortChoice));
  return options[(base + delta + options.length) % options.length] ?? EFFORT_KEEP;
}

/**
 * Tri-state effort vocabulary for the settings field-24 gate (the ←/→ cycle
 * in the settings picker): `undefined` — undocumented reasoner, the cycle
 * keeps the full canonical set; `[]` — the model documents
 * `effortSupported === false` (no effort control at all; the runtime resolver
 * drops any effort, so the cycle must go inert); otherwise the documented
 * levels. Mirrors {@link startupEffortOptions}'s tri-state handling.
 */
export function reasoningEffortVocabulary(
  rc:
    | {
        effortSupported?: boolean | undefined;
        effortLevels?: readonly string[] | undefined;
      }
    | undefined,
): string[] | undefined {
  if (rc?.effortSupported === false) return [];
  if (rc?.effortSupported && rc.effortLevels?.length) return [...rc.effortLevels];
  return undefined;
}
