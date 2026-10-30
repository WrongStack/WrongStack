import type { ParsedNextStep } from '@wrongstack/webui-protocol';
import { record } from './engine-values';

export const AUTONOMY_MODES = [
  ['off', 'Manual'],
  ['suggest', 'Suggest next steps'],
  ['auto', 'Continue automatically'],
  ['eternal', 'Eternal'],
  ['eternal-parallel', 'Eternal, parallel'],
] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number][0];

/** Seconds between the end of a turn and an automatic continuation (WebUI parity). */
export const AUTO_CONTINUE_SECONDS = 5;
/** Used only when the engine reports no `autoProceedMaxIterations`; the engine sends 0 (unlimited) when unset. */
export const DEFAULT_AUTO_CONTINUE_LIMIT = 50;

/** This conversation's continuation settings from `prefs.updated`. */
export function sessionAutonomy(prefs: unknown): {
  mode: AutonomyMode | '';
  yolo: boolean;
  limit: number;
} {
  const row = record(prefs);
  const mode = AUTONOMY_MODES.some(([id]) => id === row['autonomy'])
    ? (row['autonomy'] as AutonomyMode)
    : '';
  const limit = row['autoProceedMaxIterations'];
  return {
    mode,
    yolo: row['yolo'] === true || row['yoloPlus'] === true,
    limit:
      typeof limit === 'number' && Number.isInteger(limit) && limit >= 0
        ? limit
        : DEFAULT_AUTO_CONTINUE_LIMIT,
  };
}

/**
 * The next step a finished turn continues with automatically, or null. Only autonomy `auto`
 * with YOLO or YOLO+ continues, and only while the consecutive automatic continuations are
 * below the limit (0 = unlimited). The step marked `auto` wins; otherwise the first. The
 * marker is a preference, not a gate.
 */
export function autoContinueStep(input: {
  mode: AutonomyMode | '';
  yolo: boolean;
  limit: number;
  count: number;
  steps: readonly ParsedNextStep[];
}): ParsedNextStep | null {
  if (input.mode !== 'auto' || !input.yolo || input.steps.length === 0) return null;
  if (input.limit > 0 && input.count >= input.limit) return null;
  return input.steps.find((step) => step.auto === true) ?? input.steps[0] ?? null;
}
