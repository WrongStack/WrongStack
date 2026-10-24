import type { Config } from '@wrongstack/contracts/types';

/** Every key that may legitimately appear in a persisted config file.
 *  Mirrors the `Config` interface in @wrongstack/core types/config.ts.
 *
 *  Kept honest by `ConfigKeyCoverage` below, which is the guard this list
 *  went without for its whole life. It had drifted in BOTH directions:
 *  eight real fields — `systemPrompt`, `themePreset`, `modelTiers`,
 *  `chronicle`, `cloudSync`, `activeProfile`, `fallbackProfile`,
 *  `fallbackGateSeconds` — were reported to the user as "unknown key" even
 *  though WrongStack writes them itself (`/theme` writes `themePreset` on
 *  every theme change), and a phantom `agents` entry (that field is nested
 *  under `acp`, never top-level) waved a stray top-level `agents` block
 *  through. Add a field to `Config` and `tsc` now names it here. */
export const KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'activeProfile',
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'maxConcurrent',
  'uiLocale',
  'themePreset',
  'providers',
  'models',
  'modelMatrix',
  'modelTiers',
  'favoriteModels',
  'disabledModels',
  'disabledProviders',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'context',
  'tools',
  'mcpServers',
  'acp',
  'fallbackModels',
  'fallbackBridge',
  'fallbackProfiles',
  'fallbackProfile',
  'fallbackAuto',
  'fallbackMaxLastResortCandidates',
  'fallbackStickiness',
  'fallbackGateSeconds',
  'hooks',
  'plugins',
  'pluginManager',
  'log',
  'features',
  'Sage',
  'skills',
  'yolo',
  'nextPrediction',
  'cwd',
  'autonomy',
  'hints',
  'debugStream',
  'configScope',
  'indexing',
  'circuitBreaker',
  'adaptiveConcurrency',
  'launch',
  'session',
  'chronicle',
  'modelRuntime',
  'systemPrompt',
  'hq',
  'typesafe',
  'fleet',
  'brain',
  'sync',
  'cloudSync',
  'git',
  'observability',
  'update',
  'limits',
  'extensions',
] as const;

/** Compile-time `never` assertion: instantiating it with a non-empty union
 *  fails and the TS error text spells out the offending key names. */
type AssertNever<T extends never> = T;

/** `Config` fields the doctor would report as unknown. Must be `never`. */
type UncoveredConfigKey = Exclude<keyof Config, (typeof KNOWN_TOP_LEVEL_KEYS)[number]>;

/** Keys the list invents that `Config` does not have. Must be `never`. */
type PhantomDoctorKey = Exclude<(typeof KNOWN_TOP_LEVEL_KEYS)[number], keyof Config>;

/**
 * The drift gate. Exported so `noUnusedVariables` keeps it, and because the
 * name is what a future reader greps for when `tsc` points here.
 *
 * A runtime test cannot do this job: `keyof Config` does not survive to
 * runtime, so the previous safety net was a hand-written list of keys inside
 * `slash-doctor.test.ts` — which drifted alongside the list it was meant to
 * pin. This resolves to `never` only while both directions are clean.
 */
export type ConfigKeyCoverage = AssertNever<UncoveredConfigKey> | AssertNever<PhantomDoctorKey>;
