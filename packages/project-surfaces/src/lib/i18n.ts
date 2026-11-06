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
