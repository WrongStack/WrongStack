import { record } from './engine-values';
import type { SettingField } from './settings-fields';
import { sameSetting } from './settings-save-model';

/** The profile's refine delay (`autonomy.enhanceDelayMs`), which the terminal interface uses. */
export const enhanceDelayField: SettingField = {
  key: 'enhanceDelayMs',
  label: 'Refine delay',
  description:
    'How long the terminal interface shows a refined prompt before sending it by itself. The desktop and the WebUI wait for your choice.',
  kind: 'number',
  unit: 'seconds',
  scale: 1000,
  min: 0,
  max: 600,
};
/** This computer's refine countdown before an automatic refinement starts. */
export const refineCountdownField: SettingField = {
  key: 'enhanceCountdownMs',
  label: 'Refine countdown',
  description:
    'Grace period before a refinement that opens on submit starts; until then the prompt can be sent as written. 0 starts it at once. Saved on this computer right away.',
  kind: 'number',
  unit: 'seconds',
  scale: 1000,
  min: 0,
  max: 10,
};

const routeKeys = ['refinerProvider', 'refinerModel', 'refinerFallbackProfile'] as const;
export function refinerRoute(values: Record<string, unknown>) {
  return routeKeys.map((key) =>
    typeof values[key] === 'string' ? String(values[key]).trim() : '',
  );
}
export function prepareRefinementPolicyPatch(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...patch },
    before = refinerRoute(base),
    edited = refinerRoute(draft),
    live = refinerRoute(current);
  const routeChanged = !sameSetting(before, edited);
  if (routeChanged) {
    if (!sameSetting(before, live) && !sameSetting(edited, live))
      throw Error(
        'Refiner routing changed elsewhere. Reload saved values before applying this change.',
      );
    routeKeys.forEach((key, index) => {
      next[key] = edited[index];
    });
  } else {
    for (const key of routeKeys) delete next[key];
  }
  const resulting = { ...current, ...next },
    name = String(resulting['refinerFallbackProfile'] ?? '').trim();
  const profile = record(resulting['fallbackProfiles'])[name];
  if (routeChanged && name && !sameSetting(record(draft['fallbackProfiles'])[name], profile))
    throw Error(
      'The selected refiner profile changed elsewhere. Reload saved values before using it.',
    );
  if (
    name &&
    (routeChanged || !sameSetting(record(current['fallbackProfiles'])[name], profile)) &&
    (!Array.isArray(profile) ||
      !profile.length ||
      profile.some((entry) => typeof entry !== 'string' || !entry.trim()))
  )
    throw Error('Choose a non-empty named refiner profile, or clear it to inherit.');
  if (Object.hasOwn(next, 'enhanceEnabled') && typeof next['enhanceEnabled'] !== 'boolean')
    throw Error('Choose whether submission opens prompt refinement.');
  if (
    Object.hasOwn(next, 'enhanceLanguage') &&
    !['original', 'english'].includes(String(next['enhanceLanguage']))
  )
    throw Error('Choose the original language or English for refinement.');
  return next;
}
export function preferredRefinementVariant(
  preference: unknown,
  result: Record<string, unknown>,
): 'refined' | 'english' {
  return preference === 'english' &&
    typeof result['english'] === 'string' &&
    result['english'].trim()
    ? 'english'
    : 'refined';
}
