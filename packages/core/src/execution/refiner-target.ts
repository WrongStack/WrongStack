import type { Config } from '@wrongstack/contracts/types/config';
import { parseModelRef } from '../core/model-ref.js';

/** Which config key produced a refiner target — for logs and tests. */
export type RefinerTargetSource = 'fallback_profile' | 'explicit';

/**
 * Syntactic resolution of the dedicated-refiner config keys.
 * `providerId` / `model` are `undefined` when the caller should substitute
 * its own active provider / model.
 */
export interface RefinerTargetSpec {
  providerId?: string | undefined;
  model?: string | undefined;
  source: RefinerTargetSource;
}

/**
 * Ordered candidates from `autonomy.refinerFallbackProfile` (every entry
 * with a parseable model, in profile order) followed by the explicit
 * `autonomy.refinerProvider` + `refinerModel` pair (when any part is set).
 *
 * Single shared source for EVERY refiner surface: prompt refinement consumes
 * the first candidate via {@link resolveRefinerTargetSpec}; goal/mission
 * refinement scans the list, skipping candidates whose provider cannot be
 * built. There is deliberately NO model allow-list (such as `favoriteModels`)
 * here — the two consumers previously disagreed, with goal refinement
 * silently ignoring a configured refiner model unless it was favorited,
 * which is exactly the divergence this module removes. Whether a provider
 * can actually be built is the caller's concern.
 *
 * Pure + exported for unit testing. Returns an empty list when nothing is
 * configured.
 */
export function resolveRefinerTargetSpecs(config: Config): RefinerTargetSpec[] {
  const specs: RefinerTargetSpec[] = [];
  const profileName = config.autonomy?.refinerFallbackProfile?.trim();
  if (profileName) {
    for (const entry of config.fallbackProfiles?.[profileName] ?? []) {
      const ref = parseModelRef(entry);
      if (!ref.model) continue;
      specs.push({ providerId: ref.provider, model: ref.model, source: 'fallback_profile' });
    }
  }
  const providerId = config.autonomy?.refinerProvider?.trim() || undefined;
  const model = config.autonomy?.refinerModel?.trim() || undefined;
  if (providerId || model) specs.push({ providerId, model, source: 'explicit' });
  return specs;
}

/**
 * First configured refiner candidate, or `undefined` when nothing is
 * configured. Consumers that can skip unbuildable candidates should use
 * {@link resolveRefinerTargetSpecs} instead.
 */
export function resolveRefinerTargetSpec(config: Config): RefinerTargetSpec | undefined {
  return resolveRefinerTargetSpecs(config)[0];
}
