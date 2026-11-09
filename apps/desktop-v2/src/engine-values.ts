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
  const lines = markdown.slice(0, EXCERPT_SOURCE_LIMIT).split('\n');
  let textFollows = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const start = line.trimStart();
    if (start.startsWith('```') || start.startsWith('~~~')) lines[i] = ' ';
    // A table separator row ("|---|:-:|") carries no text.
    else if (line.includes('---') && /^[\s:|-]+$/.test(line)) lines[i] = ' ';
    else if (textFollows && /^ {0,3}#{1,6}[ \t]/.test(line)) {
      // A heading reads as a lead-in to the text after it: "Plan · Ship the fix".
      const title = trimHeadingEnd(start.replace(/^#+/, '').trim());
      lines[i] = /[.:!?]$/.test(title) ? title : `${title} ·`;
    }
    if (lines[i]?.trim()) textFollows = true;
  }
  // A "Label: value" line after other text starts a new field, not the same sentence:
  // "Manifest: package.json · File: package.json · Event: change".
  let before = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (
      before &&
      /^[A-Z][\w ]{0,30}: \S/.test(line.trim()) &&
      !/[·.:!?]\s*$/.test(lines[i - 1] ?? '')
    )
      lines[i] = `· ${line.trim()}`;
    if (line.trim()) before = true;
  }
  const plain = lines
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit =
    typeof max === 'number' && Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 100;
  if (limit === 0) return '';
  return plain.length > limit
    ? limit === 1
      ? '…'
      : `${plain.slice(0, limit - 1).trimEnd()}…`
    : plain;
}

/** A preview reads only the start of a long message. */
const EXCERPT_SOURCE_LIMIT = 4000;

/** A closing ATX sequence ("## Title ##") is not part of the title. */
function trimHeadingEnd(title: string): string {
  let end = title.length;
  while (end > 0 && (title[end - 1] === '#' || title[end - 1] === ' ' || title[end - 1] === '\t'))
    end--;
  return title.slice(0, end);
}

/** A byte count in binary units with the display language's digits ("64 MiB", "1.5 KiB", "512 B"). */
export function byteText(value: number, locale?: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units: Array<[unit: string, size: number]> = [
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
  ];
  const [unit, size] = units.find(([, size]) => value >= size) ?? ['B', 1];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / size)} ${unit}`;
}

/** A recorded time in the display language ("Nov 5, 2026, 3:21 PM"); unreadable values as-is. */
/** A label that stands alone: its first letter upper case in the display language. */
export function sentenceStart(text: string, language: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(language) + text.slice(1) : text;
}

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
