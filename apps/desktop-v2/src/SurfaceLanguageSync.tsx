import { useEffect, useRef } from 'react';
import { displayLanguage, rememberLanguage, surfaceI18n } from './surface-i18n';
import { useProfileEngine } from './useEngine';

const ignore = () => undefined;

/**
 * Keeps the desktop and the surfaces shared with the WebUI in the profile's display language,
 * and remembers it so the next start opens in it. Renders nothing; it reads the profile engine
 * on its own so the rest of the app does not re-render with it. `onKnown` is called once the
 * profile's language has been read, so a one-off reader can stop.
 */
export function SurfaceLanguageSync({ onKnown }: { onKnown?: (() => void) | undefined } = {}) {
  const { state, command } = useProfileEngine(ignore);
  const prefs = state.results['prefs.updated'];
  const asked = useRef(false);
  const known = useRef(onKnown);
  known.current = onKnown;
  useEffect(() => {
    if (!state.connected || prefs || asked.current) return;
    asked.current = true;
    void command('prefs.get', {}, ['prefs.updated']).catch(() => {
      asked.current = false;
    });
  }, [state.connected, prefs, command]);
  const language = displayLanguage(prefs);
  useEffect(() => {
    if (!prefs) return;
    rememberLanguage(language);
    if (surfaceI18n.language !== language) void surfaceI18n.changeLanguage(language);
    known.current?.();
  }, [prefs, language]);
  return null;
}
