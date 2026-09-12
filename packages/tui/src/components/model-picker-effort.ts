/**
 * Per-model reasoning-effort strip for the `/model` picker.
 *
 * Step 2 focuses one model at a time; ←/→ on that row picks the reasoning
 * effort the session should run it at. The vocabulary is MODEL-AWARE, exactly
 * like settings field 24 (`reasoners` cycle in reducers/settings-values.ts):
 * a model that documents its effort levels offers only those, an undocumented
 * reasoner offers the full canonical set (the runtime resolver drops what the
 * wire adapter cannot carry), and a non-reasoning model offers nothing at all.
 *
 * The list is always led by {@link EFFORT_KEEP} — "don't touch the configured
 * effort" — so opening the picker and pressing Enter keeps the exact behaviour
 * it had before the strip existed.
 */

import type { ReasoningEffort } from '../settings-contracts.js';
import { REASONING_EFFORTS } from './settings-picker-constants.js';

/** Sentinel first option: leave the persisted reasoning effort untouched. */
export const EFFORT_KEEP = 'default';

export type ModelEffortChoice = typeof EFFORT_KEEP | ReasoningEffort;

/** Only the fields of `ProviderOption.modelDetails[id]` this module reads. */
export interface EffortModelDetail {
  reasoning?: boolean | undefined;
  effortLevels?: readonly string[] | undefined;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Effort choices for one model, canonical order (weakest → strongest),
 * always led by `default`. Empty when the model does not reason — callers
 * treat an empty list as "no strip, arrows are inert".
 */
export function modelEffortOptions(
  detail: EffortModelDetail | undefined,
): readonly ModelEffortChoice[] {
  if (!detail?.reasoning) return [];
  const documented = (detail.effortLevels ?? []).filter(isReasoningEffort);
  const levels =
    documented.length > 0
      ? REASONING_EFFORTS.filter((level) => documented.includes(level))
      : [...REASONING_EFFORTS];
  if (levels.length === 0) return [];
  return [EFFORT_KEEP, ...levels];
}

/** Detail lookup for the focused model — the shape both reducer and view need. */
export function effortOptionsForFocused(picker: {
  step: 'provider' | 'model';
  providerOptions: ReadonlyArray<{
    id: string;
    modelDetails?: Record<string, EffortModelDetail> | undefined;
  }>;
  filteredOptions: readonly string[];
  selected: number;
  pickedProviderId?: string | undefined;
  purpose?: 'switch' | 'pick';
}): readonly ModelEffortChoice[] {
  // Generic `requestModelPick` callers (Brain pool/voters/judge) receive a
  // provider/model pair and nothing else — an effort chosen here would be
  // silently dropped, so the strip is a /model-switch-only affordance.
  if (picker.purpose === 'pick') return [];
  if (picker.step !== 'model') return [];
  const model = picker.filteredOptions[picker.selected];
  if (!model) return [];
  const provider = picker.providerOptions.find((option) => option.id === picker.pickedProviderId);
  return modelEffortOptions(provider?.modelDetails?.[model]);
}

/** Cycle the current choice by `delta`, clamped to the wrap-around list. */
export function cycleEffort(
  options: readonly ModelEffortChoice[],
  current: string,
  delta: number,
): ModelEffortChoice {
  if (options.length === 0) return EFFORT_KEEP;
  const base = Math.max(0, options.indexOf(current as ModelEffortChoice));
  const next = (base + delta + options.length) % options.length;
  return options[next] ?? EFFORT_KEEP;
}
