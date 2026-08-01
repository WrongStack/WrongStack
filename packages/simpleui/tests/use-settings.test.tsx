// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type UseSettingsResult, useSettings } from '../src/hooks/use-settings.js';
import { DEFAULT_PREFS } from '../src/lib/prefs-model.js';
import type { SimpleSocket } from '../src/lib/ws.js';

/**
 * Behavior coverage for the `useSettings` hook (plan B1 final slice,
 * extracted from simple-ui-session.tsx). Pins the initial state, the
 * `updatePrefs` / `switchAutonomy` wire ops (including the enhanceLanguage
 * co-patch), and the ref-sync contract the global shortcuts handler relies
 * on.
 *
 * Harness mirrors the sibling hook tests: jsdom + real `createRoot` + `act`,
 * no testing-library dependency.
 */

interface RecordedSend {
  type: string;
  payload: Record<string, unknown>;
}

interface Captured {
  current: UseSettingsResult | null;
}

function makeSocketStub(): {
  ref: React.RefObject<SimpleSocket | null>;
  sends: Array<RecordedSend>;
} {
  const sends: Array<RecordedSend> = [];
  // Structurally unrelated to the SimpleSocket class (private fields) —
  // cast through `unknown`, same pattern as the sibling hook tests.
  const ref = {
    current: {
      send: (type: string, payload: Record<string, unknown>) => {
        sends.push({ type, payload });
      },
    },
  } as unknown as React.RefObject<SimpleSocket | null>;
  return { ref, sends };
}

function renderProbe(captured: Captured, socket: ReturnType<typeof makeSocketStub>): Root {
  function Probe(): null {
    captured.current = useSettings({ socketRef: socket.ref });
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return root;
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('useSettings — initial state', () => {
  it('starts with DEFAULT_PREFS, the settings panel closed, and synced refs', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    expect(captured.current?.prefs).toEqual(DEFAULT_PREFS);
    expect(captured.current?.settingsOpen).toBe(false);
    expect(captured.current?.prefsRef.current).toEqual(DEFAULT_PREFS);
    expect(captured.current?.settingsOpenRef.current).toBe(false);

    roots.push(root);
  });
});

describe('useSettings — updatePrefs', () => {
  it('applies the patch locally and pushes prefs.update', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    act(() => {
      captured.current?.updatePrefs({ showModelReasoning: false });
    });

    expect(captured.current?.prefs.showModelReasoning).toBe(false);
    expect(socket.sends).toEqual([
      { type: 'prefs.update', payload: { showModelReasoning: false } },
    ]);

    roots.push(root);
  });

  it('co-patches enhanceLanguage when enhanceEnabled is set', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    act(() => {
      captured.current?.updatePrefs({ enhanceEnabled: true });
    });

    expect(captured.current?.prefs.enhanceEnabled).toBe(true);
    expect(socket.sends).toEqual([
      { type: 'prefs.update', payload: { enhanceEnabled: true, enhanceLanguage: 'english' } },
    ]);

    roots.push(root);
  });
});

describe('useSettings — switchAutonomy', () => {
  it('updates prefs.autonomy and sends autonomy.switch', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    act(() => {
      captured.current?.switchAutonomy('auto');
    });

    expect(captured.current?.prefs.autonomy).toBe('auto');
    expect(socket.sends).toEqual([{ type: 'autonomy.switch', payload: { mode: 'auto' } }]);

    roots.push(root);
  });
});

describe('useSettings — refs track live values', () => {
  it('keeps prefsRef and settingsOpenRef in sync across updates', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    act(() => {
      captured.current?.updatePrefs({ yolo: true });
    });
    expect(captured.current?.prefsRef.current?.yolo).toBe(true);

    act(() => {
      captured.current?.setSettingsOpen(true);
    });
    expect(captured.current?.settingsOpen).toBe(true);
    expect(captured.current?.settingsOpenRef.current).toBe(true);

    roots.push(root);
  });
});
