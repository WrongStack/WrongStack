import { type RefObject, useCallback, useRef, useState } from 'react';
import { type AutonomyMode, DEFAULT_PREFS, type SimplePrefs } from '../lib/prefs-model.js';
import type { SimpleSocket } from '../lib/ws.js';

export interface UseSettingsOptions {
  socketRef: RefObject<SimpleSocket | null>;
}

export interface UseSettingsResult {
  prefs: SimplePrefs;
  setPrefs: React.Dispatch<React.SetStateAction<SimplePrefs>>;
  prefsRef: RefObject<SimplePrefs>;
  settingsOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsOpenRef: RefObject<boolean>;
  /** Apply a partial prefs patch locally and push it to the server. */
  updatePrefs: (patch: Partial<SimplePrefs>) => void;
  /** Switch autonomy mode: local prefs update + `autonomy.switch` wire op. */
  switchAutonomy: (mode: AutonomyMode) => void;
}

/**
 * Owns the SimpleUI settings/prefs projection: the prefs snapshot (fed from
 * server `prefs.*` frames through the message handler's `setPrefs`), the
 * settings-panel open state, their refs for live reads, and the
 * update/switch commands. Extracted from `simple-ui-session.tsx` (plan B1
 * final slice).
 *
 * Refs are kept in sync every render so the global keyboard handler and the
 * other hooks can read live state without re-registering listeners.
 */
export function useSettings(options: UseSettingsOptions): UseSettingsResult {
  const { socketRef } = options;
  const [prefs, setPrefs] = useState<SimplePrefs>(DEFAULT_PREFS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prefsRef = useRef<SimplePrefs>(DEFAULT_PREFS);
  const settingsOpenRef = useRef(false);
  prefsRef.current = prefs;
  settingsOpenRef.current = settingsOpen;

  const updatePrefs = useCallback(
    (patch: Partial<SimplePrefs>) => {
      const nextPatch = patch.enhanceEnabled ? { enhanceLanguage: 'english', ...patch } : patch;
      setPrefs((current) => ({ ...current, ...patch }));
      socketRef.current?.send('prefs.update', nextPatch as Record<string, unknown>);
    },
    [socketRef],
  );

  const switchAutonomy = useCallback(
    (mode: AutonomyMode) => {
      setPrefs((current) => ({ ...current, autonomy: mode }));
      // Autonomy has its own route: prefs.update only writes meta, which the
      // running loop never reads.
      socketRef.current?.send('autonomy.switch', { mode });
    },
    [socketRef],
  );

  return {
    prefs,
    setPrefs,
    prefsRef,
    settingsOpen,
    setSettingsOpen,
    settingsOpenRef,
    updatePrefs,
    switchAutonomy,
  };
}
