import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Appearance,
  applyAppearance,
  defaultAppearance,
  parseAppearance,
  resolvedMode,
} from './appearance';
import { native, request } from './platform';

const cacheKey = 'wrongstack.desktop.appearance';
export function cachedAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(cacheKey));
  } catch {
    return defaultAppearance;
  }
}
export function useAppearance(
  persisted: string | null | undefined,
  onError: (error: unknown) => void,
) {
  const [appearance, setAppearance] = useState(cachedAppearance);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [systemMore, setSystemMore] = useState(
    () => matchMedia('(prefers-contrast: more)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(prefers-contrast: more)');
    const update = () => setSystemMore(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const awaiting = useRef<string | null>(null);
  const serial = useRef(Promise.resolve());
  const latest = useRef(appearance);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (persisted === undefined) return;
    if (awaiting.current && awaiting.current !== persisted) return;
    awaiting.current = null;
    const restored = parseAppearance(persisted);
    latest.current = restored;
    setAppearance(restored);
  }, [persisted]);
  useEffect(() => {
    applyAppearance(appearance, systemDark, systemMore);
    try {
      localStorage.setItem(cacheKey, JSON.stringify(appearance));
    } catch {
      /* Native storage remains authoritative. */
    }
  }, [appearance, systemDark, systemMore]);
  const changeAppearance = useCallback(
    (patch: Partial<Appearance>) => {
      const next = { ...latest.current, ...patch };
      if (
        next.mode === latest.current.mode &&
        next.accent === latest.current.accent &&
        next.contrast === latest.current.contrast
      )
        return;
      latest.current = next;
      setAppearance(next);
      if (!native) return;
      // Every write has its own identity, including a quick A → B → A change between polls.
      const value = JSON.stringify({ ...next, revision: crypto.randomUUID() });
      awaiting.current = value;
      serial.current = serial.current.then(async () => {
        try {
          await request('settings.save', { key: 'appearance', value });
        } catch (error) {
          if (awaiting.current === value) awaiting.current = null;
          onError(error);
        }
      });
    },
    [onError],
  );
  return { appearance, changeAppearance, mode: resolvedMode(appearance, systemDark) };
}
