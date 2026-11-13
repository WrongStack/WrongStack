import { useEffect, useRef, useSyncExternalStore } from 'react';

/** The WrongStack settings sections a command or the main rail can open directly. */
export type SettingsTarget = 'integrations' | 'health' | 'tool-access' | 'brain' | 'quota';

let pending: SettingsTarget | null = null;
let mounted: ((section: SettingsTarget) => void) | null = null;
let shown: string | null = null;
const watchers = new Set<() => void>();

/**
 * Asks the WrongStack settings page to show `section`: at once when the page is open, otherwise
 * the next time it opens.
 */
export function requestSettingsSection(section: SettingsTarget): void {
  if (mounted) mounted(section);
  else {
    pending = section;
    // While the settings engine is still starting the page cannot report the section yet;
    // the rail and the title already name the one that was asked for.
    setShown(section);
  }
}

/**
 * Hands the settings page the section a command asked for, once: a request made before the page
 * mounts is taken when it does, so opening settings later from the sidebar starts where it
 * normally does. A request made while the page is open switches it there.
 */
export function useRequestedSettingsSection(open: (section: SettingsTarget) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const deliver = (section: SettingsTarget) => latest.current(section);
    mounted = deliver;
    const wanted = pending;
    pending = null;
    if (wanted) deliver(wanted);
    return () => {
      if (mounted === deliver) mounted = null;
    };
  }, []);
}

/** The settings page reports the section it shows, so the main rail can mark its shortcut. */
export function useReportSettingsSection(section: string): void {
  useEffect(() => {
    setShown(section);
    return () => setShown(null);
  }, [section]);
}

/** The section the open settings page shows, or null while it is closed. */
export function useShownSettingsSection(): string | null {
  return useSyncExternalStore(
    (notify) => {
      watchers.add(notify);
      return () => watchers.delete(notify);
    },
    () => shown,
  );
}

function setShown(section: string | null) {
  if (shown === section) return;
  shown = section;
  for (const notify of watchers) notify();
}
