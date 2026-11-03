import { useEffect, useRef } from 'react';
import { displayLanguage, surfaceI18n } from './surface-i18n';
import { useProfileEngine } from './useEngine';

const ignore = () => undefined;

/**
 * Keeps the surfaces shared with the WebUI in the profile's display language. Renders nothing;
 * it reads the profile engine on its own so the rest of the app does not re-render with it.
 */
export function SurfaceLanguageSync() {
  const { state, command } = useProfileEngine(ignore);
  const prefs = state.results['prefs.updated'];
  const asked = useRef(false);
  useEffect(() => {
    if (!state.connected || prefs || asked.current) return;
    asked.current = true;
    void command('prefs.get', {}, ['prefs.updated']).catch(() => {
      asked.current = false;
    });
  }, [state.connected, prefs, command]);
  const language = displayLanguage(prefs);
  useEffect(() => {
    if (surfaceI18n.language !== language) void surfaceI18n.changeLanguage(language);
  }, [language]);
  return null;
}
