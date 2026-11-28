/** A hue for a name's monogram: the same name always gets the same tint, in any list. */
export function markHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** The first letter of a name for its monogram (a whole grapheme, not half a surrogate pair). */
export function monogram(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/** How long ago in the fewest characters ("now", "5m", "3h", "2d"), for tight lists. */
export function compactAge(
  timestamp: number,
  say: (unit: 'now' | 'minutes' | 'hours' | 'days', count: number) => string,
  now = Date.now(),
): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return say('now', 0);
  if (minutes < 60) return say('minutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say('hours', hours);
  return say('days', Math.floor(hours / 24));
}
