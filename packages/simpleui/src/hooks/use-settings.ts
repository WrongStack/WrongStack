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
  /**
   * Reset every pref to `DEFAULT_PREFS`: optimistically update local state so
   * the panel reflects defaults within one frame, then broadcast the same
   * patch as a `prefs.update` so the server (and any other tabs) catch up.
   * The server is still the source of truth — its `prefs.updated` echo will
   * re-confirm the values, but the local snapshot guarantees the user sees
   * an immediate reset even if the socket is slow.
   */
  resetPrefs: () => void;
  /** True when `prefs` matches `DEFAULT_PREFS` field-for-field. */
  isAtDefaults: boolean;
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

  const resetPrefs = useCallback(() => {
    // Optimistic local snapshot — the panel needs an immediate visual reset
    // even if the socket is slow. The server's `prefs.updated` echo will
    // re-confirm the values on the next round-trip.
    const resettable = {
      ...DEFAULT_PREFS,
      subagentsAllowed: prefsRef.current.subagentsAllowed,
      subagentsPolicyLocked: prefsRef.current.subagentsPolicyLocked,
    };
    setPrefs(resettable);
    // Two wire ops: prefs.update persists the snapshot so other tabs catch up,
    // and autonomy.switch re-aims the running loop at the default mode — the
    // loop reads autonomy from `autonomy.switch` traffic, never from
    // prefs.update, so sending only the latter would leave a stale YOLO/auto
    // agent running even though the panel shows `off`.
    const { subagentsAllowed: _allowed, subagentsPolicyLocked: _locked, ...durable } = resettable;
    socketRef.current?.send('prefs.update', durable);
    socketRef.current?.send('autonomy.switch', { mode: DEFAULT_PREFS.autonomy });
  }, [socketRef]);

  const isAtDefaults = shallowEqualPrefs(prefs, DEFAULT_PREFS);

  return {
    prefs,
    setPrefs,
    prefsRef,
    settingsOpen,
    setSettingsOpen,
    settingsOpenRef,
    updatePrefs,
    switchAutonomy,
    resetPrefs,
    isAtDefaults,
  };
}

/**
 * Field-by-field shallow equality on the stable SimplePrefs shape. Plain
 * JSON.stringify would also work but allocates on every render — this loop
 * short-circuits on the first mismatch and stays cheap when the panel
 * re-renders for unrelated reasons (search input, etc.).
 */
function shallowEqualPrefs(a: SimplePrefs, b: SimplePrefs): boolean {
  const keys: (keyof SimplePrefs)[] = [
    'autonomy',
    'yolo',
    'enhanceEnabled',
    'preRefineSeconds',
    'showModelReasoning',
    'chime',
    'confirmExit',
    'refinerProvider',
    'refinerModel',
    'refinerFallbackProfile',
    'fallbackProfiles',
  ];
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (key === 'fallbackProfiles') {
      // fallbackProfiles is a Record<string, string[]> — compare via keys+values.
      const aMap = av as Record<string, string[]>;
      const bMap = bv as Record<string, string[]>;
      const aKeys = Object.keys(aMap);
      const bKeys = Object.keys(bMap);
      if (aKeys.length !== bKeys.length) return false;
      for (const k of aKeys) {
        const aArr = aMap[k] ?? [];
        const bArr = bMap[k] ?? [];
        if (aArr.length !== bArr.length) return false;
        for (let i = 0; i < aArr.length; i++) {
          if (aArr[i] !== bArr[i]) return false;
        }
      }
      continue;
    }
    if (av !== bv) return false;
  }
  return true;
}
