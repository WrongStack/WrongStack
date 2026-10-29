import { record } from './engine-values';

export function designTokens(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
export function designTheme(
  base: unknown,
  overrides: Record<string, string>,
  theme: 'light' | 'dark',
): Record<string, string> {
  const result = designTokens(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('light.')) {
      if (theme === 'light') result[key.slice(6)] = value;
    } else if (key.startsWith('dark.')) {
      if (theme === 'dark') result[key.slice(5)] = value;
    } else result[key] = value;
  }
  return result;
}
export function designOverrideConflict(
  baseline: Record<string, string>,
  current: Record<string, string>,
  patch: Record<string, string>,
): boolean {
  return Object.keys(patch).some(
    (key) => current[key] !== baseline[key] && current[key] !== patch[key],
  );
}
export function designValuesMatch(
  saved: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(([key, value]) => saved[key] === value);
}
export function designColorValue(value: string): boolean {
  if (typeof CSS !== 'undefined') return CSS.supports('color', value) && !/\bvar\(/i.test(value);
  return /^(?:#[a-f\d]{3,8}|(?:oklch|oklab|hsl|hsla|rgb|rgba)\([\d\s.%+,/-]+\)|transparent|black|white)$/i.test(
    value.trim(),
  );
}
/**
 * The `expected` of a checked override write: the kit and, for each key being written, the
 * value just read ('' = no override). The engine refuses the write if either changed since.
 */
export function designOverrideExpectation(
  kit: string,
  current: Record<string, string>,
  patch: Record<string, string>,
): { kit: string; values: Record<string, string> } {
  return {
    kit,
    values: Object.fromEntries(Object.keys(patch).map((key) => [key, current[key] ?? ''])),
  };
}
