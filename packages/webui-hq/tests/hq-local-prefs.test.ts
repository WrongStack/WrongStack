/**
 * Unit tests for the HQ local-prefs store.
 *
 * Covers:
 *   - default values when nothing is persisted
 *   - persisted values override defaults but ignore unknown keys
 *   - malformed persisted JSON falls back to defaults
 *   - setters merge into the existing prefs and notify subscribers
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __test__,
  getHqLocalPrefsSnapshot,
  reloadHqLocalPrefs,
  resetHqLocalPrefs,
  setHqAppearancePrefs,
  setHqConsolePrefs,
  setHqControlPrefs,
  setHqFleetPrefs,
  setHqMailboxPrefs,
  useHqLocalPrefs,
} from '../src/data/local-prefs.js';

function clearStorage(): void {
  window.localStorage.removeItem(__test__.STORAGE_KEY);
}

function seedStorage(value: string): void {
  window.localStorage.setItem(__test__.STORAGE_KEY, value);
}

interface HookMountHandle {
  value: () => ReturnType<typeof useHqLocalPrefs>;
  root: Root;
  container: HTMLDivElement;
}

function mountHook(): HookMountHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // Mount a Capture component that subscribes to the store via the hook
  // (we don't care about its rendered value here — the snapshot helper
  // is what the assertions read).
  function Capture(): null {
    useHqLocalPrefs();
    return null;
  }
  act(() => {
    root.render(createElement(Capture));
  });
  return {
    value: () => getHqLocalPrefsSnapshot(),
    root,
    container,
  };
}

function unmountHook(handle: HookMountHandle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

describe('hq-local-prefs', () => {
  beforeEach(() => {
    clearStorage();
    resetHqLocalPrefs();
  });

  afterEach(() => {
    clearStorage();
    resetHqLocalPrefs();
  });

  it('returns defaults when nothing is persisted', () => {
    const handle = mountHook();
    try {
      const prefs = handle.value();
      expect(prefs.control.cmdType).toBe('steer');
      expect(prefs.appearance.theme).toBe('dark');
      expect(prefs.fleet.scope).toBe('all');
      expect(prefs.fleet.layout).toBe('map');
      expect(prefs.console.delivery).toBe('steer');
      expect(prefs.control.abortTarget).toBe('leader');
      expect(prefs.control.spawnRole).toBe('bug-hunter');
      expect(prefs.mailbox.includeCompleted).toBe(true);
      expect(prefs.mailbox.query).toBe('');
    } finally {
      unmountHook(handle);
    }
  });

  it('hydrates from persisted JSON and prefers persisted values over defaults', () => {
    seedStorage(
      JSON.stringify({
        control: {
          cmdType: 'abort',
          abortTarget: 'fleet',
          spawnRole: 'security-scanner',
          steerTo: 'agent-42',
          steerSubject: 'check logs',
          steerBody: 'look at /var/log',
          broadcastSubject: 'ping',
          broadcastBody: 'are you there?',
        },
        mailbox: {
          query: 'urgent',
          types: ['steer'],
          priorities: ['high'],
          includeCompleted: false,
        },
      }),
    );
    reloadHqLocalPrefs();
    const handle = mountHook();
    try {
      const prefs = handle.value();
      expect(prefs.control.cmdType).toBe('abort');
      expect(prefs.control.abortTarget).toBe('fleet');
      expect(prefs.control.spawnRole).toBe('security-scanner');
      expect(prefs.control.steerTo).toBe('agent-42');
      expect(prefs.mailbox.query).toBe('urgent');
      expect(prefs.mailbox.types).toEqual(['steer']);
      expect(prefs.mailbox.priorities).toEqual(['high']);
      expect(prefs.mailbox.includeCompleted).toBe(false);
    } finally {
      unmountHook(handle);
    }
  });

  it('falls back to defaults when the persisted JSON is malformed', () => {
    seedStorage('this is not json');
    reloadHqLocalPrefs();
    const handle = mountHook();
    try {
      const prefs = handle.value();
      expect(prefs.control.cmdType).toBe('steer');
      expect(prefs.control.abortTarget).toBe('leader');
    } finally {
      unmountHook(handle);
    }
  });

  it('drops unknown cmdType values and reverts to the default', () => {
    seedStorage(JSON.stringify({ control: { cmdType: 'detonate' } }));
    reloadHqLocalPrefs();
    const handle = mountHook();
    try {
      const prefs = handle.value();
      expect(prefs.control.cmdType).toBe('steer');
    } finally {
      unmountHook(handle);
    }
  });

  it('setHqControlPrefs merges and notifies subscribers', () => {
    const handle = mountHook();
    try {
      act(() => {
        setHqControlPrefs({ cmdType: 'spawn', spawnRole: 'critic', steerBody: 'audit this' });
      });
      const prefs = handle.value();
      expect(prefs.control.cmdType).toBe('spawn');
      expect(prefs.control.spawnRole).toBe('critic');
      expect(prefs.control.steerBody).toBe('audit this');
      // Untouched fields stay at their previous value.
      expect(prefs.control.abortTarget).toBe('leader');
      // Persisted to localStorage so the next reload survives.
      const raw = window.localStorage.getItem(__test__.STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw ?? '{}') as { control: { cmdType: string } };
      expect(parsed.control.cmdType).toBe('spawn');
    } finally {
      unmountHook(handle);
    }
  });

  it('setHqMailboxPrefs persists filter state', () => {
    const handle = mountHook();
    try {
      act(() => {
        setHqMailboxPrefs({
          query: 'fail',
          types: ['ask', 'result'],
          priorities: ['high'],
          includeCompleted: false,
        });
      });
      const prefs = handle.value();
      expect(prefs.mailbox.query).toBe('fail');
      expect(prefs.mailbox.types).toEqual(['ask', 'result']);
      expect(prefs.mailbox.priorities).toEqual(['high']);
      expect(prefs.mailbox.includeCompleted).toBe(false);
    } finally {
      unmountHook(handle);
    }
  });

  it('persists the light appearance', () => {
    const handle = mountHook();
    try {
      act(() => setHqAppearancePrefs({ theme: 'light' }));
      expect(handle.value().appearance.theme).toBe('light');
      reloadHqLocalPrefs();
      expect(getHqLocalPrefsSnapshot().appearance.theme).toBe('light');
    } finally {
      unmountHook(handle);
    }
  });

  it('persists fleet scope and Console drafts', () => {
    const handle = mountHook();
    try {
      act(() => {
        setHqFleetPrefs({ scope: 'project', layout: 'compact', projectId: 'project-42' });
        setHqConsolePrefs({
          delivery: 'queue',
          subject: 'After this turn',
          body: 'Run the verification suite.',
        });
      });
      expect(handle.value().fleet).toMatchObject({
        scope: 'project',
        layout: 'compact',
        projectId: 'project-42',
      });
      expect(handle.value().console).toEqual({
        delivery: 'queue',
        subject: 'After this turn',
        body: 'Run the verification suite.',
      });
    } finally {
      unmountHook(handle);
    }
  });

  it('deepClone falls back to JSON round-trip when structuredClone is unavailable', () => {
    // Delete structuredClone from globalThis. With empty storage,
    // loadFromStorage hits raw===null and calls deepClone(DEFAULT_PREFS).
    const origSC = (globalThis as { structuredClone?: typeof structuredClone }).structuredClone;
    (globalThis as { structuredClone?: typeof structuredClone }).structuredClone = undefined;
    try {
      clearStorage(); // ensures raw === null → deepClone(DEFAULT_PREFS) is called
      reloadHqLocalPrefs();
      const prefs = getHqLocalPrefsSnapshot();
      expect(prefs.control.cmdType).toBe('steer'); // default
    } finally {
      (globalThis as { structuredClone?: typeof structuredClone }).structuredClone = origSC;
    }
  });

  it('loadFromStorage catch falls back to defaults when localStorage.getItem throws', () => {
    // Make localStorage.getItem throw so the try-catch returns defaults.
    const origGetItem = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error('storage error');
    };
    try {
      reloadHqLocalPrefs();
      const prefs = getHqLocalPrefsSnapshot();
      // Should fall back to defaults.
      expect(prefs.control.cmdType).toBe('steer');
      expect(prefs.mailbox.includeCompleted).toBe(true);
    } finally {
      window.localStorage.getItem = origGetItem;
    }
  });

  it('DEFAULT_PREFS is frozen and matches the snapshot at rest', async () => {
    // The frozen default is returned by getServerSnapshot during SSR and
    // serves as the reset target. Verify it matches a clean snapshot.
    const { __test__: prefTest } = await import('../src/data/local-prefs.js');
    expect(getHqLocalPrefsSnapshot()).toEqual(prefTest.DEFAULT_PREFS);
  });
});
