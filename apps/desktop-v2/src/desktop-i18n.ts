import { useTranslation } from 'react-i18next';
import { surfaceI18n } from './surface-i18n';

/**
 * The desktop shell's own strings (`desktop` namespace) in the profile's display language.
 * Components outside a surface frame use it too, so the instance is passed explicitly.
 */
export function useDesktopText() {
  return useTranslation('desktop', { i18n: surfaceI18n });
}
