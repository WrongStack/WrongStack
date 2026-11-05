export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((item) => contentText(record(item)['text'] ?? record(item)['content']))
      .filter(Boolean)
      .join('\n');
  return '';
}

/**
 * A millisecond span in the largest whole-ish unit, in the display language ("6 hr", "90 min"):
 * settings and policies stored in milliseconds read as raw numbers like 21,600,000 ms.
 */
export function durationText(value: unknown, locale?: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units: Array<[unit: 'day' | 'hour' | 'minute' | 'second', size: number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1_000],
  ];
  const [unit, size] = units.find(([, size]) => value >= size) ?? ['second', 1_000];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value / size);
}

/** A recorded time in the display language ("Nov 5, 2026, 3:21 PM"); unreadable values as-is. */
export function dateTimeText(value: unknown, locale?: string): string {
  const at = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : String(value ?? '');
}
