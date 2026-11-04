import { useEffect, useRef } from 'react';

/** The WrongStack settings sections a command can open directly. */
export type SettingsTarget = 'integrations' | 'health' | 'tool-access' | 'brain';

let pending: SettingsTarget | null = null;

/** Asks the WrongStack settings page to show `section` the next time it opens. */
export function requestSettingsSection(section: SettingsTarget): void {
  pending = section;
}

/**
 * Hands the settings page the section a command asked for, once: the request is taken when the
 * page mounts, so opening settings later from the sidebar starts where it normally does.
 */
export function useRequestedSettingsSection(open: (section: SettingsTarget) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const wanted = pending;
    pending = null;
    if (wanted) latest.current(wanted);
  }, []);
}
