import { surfaceI18n } from './surface-i18n';

/**
 * Dates and times in the profile's display language. A bare `toLocaleString()` follows the
 * operating system's locale instead, so a Turkish interface on an English system showed
 * "11/6/2026, 3:10:48 PM" beside Turkish words. Components re-render on a language change
 * through `useDesktopText`, which re-reads the language here.
 */
function at(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function format(value: unknown, options: Intl.DateTimeFormatOptions): string {
  const date = at(value);
  if (!date) return String(value ?? '');
  try {
    return date.toLocaleString(surfaceI18n.language || undefined, options);
  } catch {
    return date.toLocaleString(undefined, options);
  }
}

/** A moment with its date: "Nov 6, 2026, 3:10 PM". */
export const displayDateTime = (value: unknown) =>
  format(value, { dateStyle: 'medium', timeStyle: 'short' });

/** A time of day to the second, for timelines read within one day: "3:10:48 PM". */
export const displayTime = (value: unknown) => format(value, { timeStyle: 'medium' });

/** A calendar date: "Nov 6, 2026". */
export const displayDate = (value: unknown) => format(value, { dateStyle: 'medium' });

/**
 * The display language as a locale argument, for numbers and other values formatted in
 * place (`count.toLocaleString(displayLocale())`); undefined before the catalog loads.
 */
export const displayLocale = (): string | undefined => surfaceI18n.language || undefined;
