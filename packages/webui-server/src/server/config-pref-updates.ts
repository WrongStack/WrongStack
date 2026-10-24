import type { Config } from '@wrongstack/contracts/types';

/**
 * The five feature flags the settings pane can toggle. Typed on purpose: these
 * are exactly the five REQUIRED booleans of `FeaturesConfig`, so a typo in a
 * target key is a compile error rather than a silently-ignored setting.
 */
type FeatureFlagKey = 'mcp' | 'plugins' | 'memory' | 'modelsRegistry' | 'skills' | 'toolCoach';
const FEATURE_PREF_KEYS: ReadonlyArray<readonly [string, FeatureFlagKey]> = [
  ['featureMcp', 'mcp'],
  ['featurePlugins', 'plugins'],
  ['featureMemory', 'memory'],
  ['featureSkills', 'skills'],
  ['featureModelsRegistry', 'modelsRegistry'],
  ['featureToolCoach', 'toolCoach'],
];

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined;
}

function fallbackProfileMap(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries: Array<[string, string[]]> = [];
  for (const [key, models] of Object.entries(value)) {
    const validated = stringList(models);
    if (validated !== undefined) entries.push([key, validated]);
  }
  return Object.fromEntries(entries);
}

/**
 * Translate a settings-pane payload into a config patch. Pure: it reads
 * `config` and returns new objects, touching neither.
 *
 * Extracted from `applyConfigPrefs` so it can be tested without standing up
 * the whole router. That mattered here — the only existing coverage
 * (`prefs-handlers.test.ts`) supplies `applyConfigPrefs` as a `vi.fn()`, so the
 * real implementation had never run in a test, and the bug below survived.
 *
 * The previous implementation assigned onto `state.getConfig()` directly.
 * `ConfigLoader` returns `Object.freeze(cfg)` (`config-loader.ts:287`) and
 * `patchConfig` re-freezes (`boot.ts:30`), so in an ESM module — always strict
 * mode — the first write threw `Cannot assign to read only property
 * 'features'` and took the whole settings-save message handler with it.
 *
 * `Object.freeze` is SHALLOW, which is why the nested `features['mcp'] = …`
 * writes that ran just before it appeared to work: they mutated the live
 * config's nested object in place, visible to every other holder of that
 * config and recorded through no setter. Returning fresh objects fixes the
 * crash and that silent aliasing together.
 */
export function computeConfigPrefUpdates(
  config: Config,
  payload: Record<string, unknown>,
): Partial<Config> {
  const updates: Partial<Config> = {};

  const featureChanges: Partial<Record<FeatureFlagKey, boolean>> = {};
  for (const [prefKey, cfgKey] of FEATURE_PREF_KEYS) {
    const value = payload[prefKey];
    if (typeof value === 'boolean') featureChanges[cfgKey] = value;
  }
  if (Object.keys(featureChanges).length > 0) {
    // The one cast: a config whose `features` block is absent entirely yields
    // a partial here. That was equally true of the previous `as never`; the
    // loader materializes the block in practice, and a partial merge is still
    // strictly better than the in-place mutation it replaces.
    updates.features = {
      ...config.features,
      ...featureChanges,
    } as NonNullable<Config['features']>;
  }

  const fallbackModels = stringList(payload['fallbackModels']);
  if (fallbackModels !== undefined) updates.fallbackModels = fallbackModels;
  const fallbackProfiles = fallbackProfileMap(payload['fallbackProfiles']);
  if (fallbackProfiles !== undefined) updates.fallbackProfiles = fallbackProfiles;
  const favoriteModels = stringList(payload['favoriteModels']);
  if (favoriteModels !== undefined) updates.favoriteModels = favoriteModels;
  const disabledModels = stringList(payload['disabledModels']);
  if (disabledModels !== undefined) updates.disabledModels = disabledModels;
  const disabledProviders = stringList(payload['disabledProviders']);
  if (disabledProviders !== undefined) updates.disabledProviders = disabledProviders;
  if (typeof payload['favoriteModelsOnly'] === 'boolean')
    updates.favoriteModelsOnly = payload['favoriteModelsOnly'];
  if (Array.isArray(payload['modelAvailabilitySchedule']))
    updates.modelAvailabilitySchedule = structuredClone(
      payload['modelAvailabilitySchedule'],
    ) as import('@wrongstack/core/models').ModelBlackoutRule[];
  if (
    payload['modelMatrix'] &&
    typeof payload['modelMatrix'] === 'object' &&
    !Array.isArray(payload['modelMatrix'])
  ) {
    updates.modelMatrix = structuredClone(payload['modelMatrix']) as NonNullable<
      Config['modelMatrix']
    >;
  }
  if (typeof payload['fallbackAuto'] === 'boolean') updates.fallbackAuto = payload['fallbackAuto'];

  return updates;
}
