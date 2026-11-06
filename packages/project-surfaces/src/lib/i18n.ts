import { getI18n } from 'react-i18next';

/**
 * The surfaces translate with whichever i18next instance the app provides (the WebUI's own
 * catalog, or the desktop's copy of it through an `I18nextProvider`).
 */
export { useTranslation as useAppTranslation } from 'react-i18next';

/**
 * The display language as a locale argument for numbers and dates formatted in place
 * (`count.toLocaleString(displayLocale())`). A bare `toLocaleString()` follows the operating
 * system instead, so an English interface on a Turkish system printed "2.000". Both apps
 * register their instance with react-i18next; undefined before one is ready.
 */
export function displayLocale(): string | undefined {
  try {
    return getI18n()?.language || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A number with a fixed count of decimals in the display language's separators: `toFixed`
 * always writes a dot ("1.5 MB" in a Turkish interface that writes "1,5"). `trim` drops
 * trailing zeros. No digit grouping, as with `toFixed`.
 */
export function displayDecimal(value: number, digits: number, trim = false): string {
  const locale = displayLocale();
  // No display language yet (nothing registered): keep the toFixed dot, not the OS locale.
  if (!locale) return trim ? String(Number(value.toFixed(digits))) : value.toFixed(digits);
  try {
    return value.toLocaleString(locale, {
      minimumFractionDigits: trim ? 0 : digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
  } catch {
    return trim ? String(Number(value.toFixed(digits))) : value.toFixed(digits);
  }
}
