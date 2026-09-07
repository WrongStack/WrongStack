/**
 * The behavior half of the config — the sections `CONFIG_BEHAVIOR_DEFAULTS`
 * defines that describe *how the product behaves*. One shared list so
 * `/settings reset` (factory restore) and `wstack config-export` /
 * `wstack config-import` (portable settings transfer) can never drift apart.
 *
 * Identity and user-owned namespaces are NEVER part of this set: `provider`,
 * `model`, `providers` (API keys), `mcpServers`, `extensions`, `plugins`,
 * `hq`, `launch`, `fallbackAuto`, `fallbackProfiles`, `fallbackModels`,
 * `fallbackBridge`, `favoriteModels*`, `modelMatrix`, `modelTiers`,
 * `configScope`, `uiLocale`, `version`, `activeProfile`. Portable exports are
 * therefore structurally free of credentials and model-routing data.
 */
export const BEHAVIOR_SECTION_KEYS = [
  'context',
  'tools',
  'log',
  'features',
  'session',
  'indexing',
  'circuitBreaker',
  'modelRuntime',
  'Sage',
  'skills',
  'systemPrompt',
  'autonomy',
  'maxConcurrent',
  'yolo',
  'nextPrediction',
  'hints',
  'debugStream',
] as const;

export type BehaviorSectionKey = (typeof BEHAVIOR_SECTION_KEYS)[number];

/** Deep-copy the behavior sections out of a loaded config. */
export function extractBehaviorSettings(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BEHAVIOR_SECTION_KEYS) {
    const value = config[key];
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out;
}

/** Merge behavior sections from a portable export over an existing config object. */
export function mergeBehaviorSettings(
  target: Record<string, unknown>,
  settings: Record<string, unknown>,
): string[] {
  const applied: string[] = [];
  for (const key of BEHAVIOR_SECTION_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object') {
      const current = (target[key] as Record<string, unknown> | null | undefined) ?? {};
      target[key] = { ...current, ...(value as Record<string, unknown>) };
    } else {
      target[key] = value;
    }
    applied.push(key);
  }
  return applied;
}
