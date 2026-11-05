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

/**
 * Markdown as one line of plain text for a list preview: fences, headings, quotes, list marks,
 * emphasis, inline code, links and table rules give way to their words; long text ends in "…".
 */
export function markdownExcerpt(markdown: string, max = 100): string {
  const plain = markdown
    .replace(/^\s*(```|~~~).*$/gm, ' ')
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** A byte count in binary units with the display language's digits ("64 MiB", "1.5 KiB", "512 B"). */
export function byteText(value: number, locale?: string): string {
  const units: Array<[unit: string, size: number]> = [
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
  ];
  const [unit, size] = units.find(([, size]) => value >= size) ?? ['B', 1];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / size)} ${unit}`;
}

/** A recorded time in the display language ("Nov 5, 2026, 3:21 PM"); unreadable values as-is. */
/**
 * A counted noun from the `counts` catalog ("1 task", "3 tasks"). Without a number the noun
 * stays and the number reads "—" ("— tasks"): the plural phrase is rendered for 2, whose
 * formatted digit is the only "2" in it, and that digit is replaced.
 */
export function countedPhrase(
  t: (key: string, options: { count: number }) => string,
  key: string,
  value: unknown,
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? t(`counts.${key}`, { count: value })
    : t(`counts.${key}`, { count: 2 }).replace('2', '—');
}

export function dateTimeText(value: unknown, locale?: string): string {
  const at = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : String(value ?? '');
}
