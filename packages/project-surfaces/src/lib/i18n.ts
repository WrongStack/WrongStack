/**
 * The surfaces translate with whichever i18next instance the app provides (the WebUI's own
 * catalog, or the desktop's copy of it through an `I18nextProvider`).
 */
export { useTranslation as useAppTranslation } from 'react-i18next';
