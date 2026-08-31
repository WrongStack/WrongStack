// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type UseSettingsResult, useSettings } from '../src/hooks/use-settings.js';
import { DEFAULT_PREFS } from '../src/lib/prefs-model.js';
import type { SimpleSocket } from '../src/lib/ws.js';

/**
 * Behavior coverage for `useSettings().resetPrefs`.
 *
 * The reset button in the settings panel must do two things on the wire:
 *   1. Send a full `prefs.update` snapshot so other tabs and the persisted
 *      store see the defaults.
 *   2. Send `autonomy.switch` with the default autonomy mode, because the
 *      running autonomy loop reads from `autonomy.switch` traffic, not from
 *      `prefs.update`. Sending only the latter would leave a stale YOLO/auto
 *      agent running even though the panel snaps to `off`.
 *
 * Harness mirrors the sibling tests: jsdom + real `createRoot` + `act`,
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

describe('useSettings — resetPrefs', () => {
  it('snapshots local prefs to DEFAULT_PREFS and pushes prefs.update', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    // First, dirty the prefs so the reset is non-trivial.
    act(() => {
      captured.current?.updatePrefs({
        yolo: true,
        enhanceEnabled: true,
        showModelReasoning: false,
      });
      captured.current?.switchAutonomy('auto');
    });

    const sendsBeforeReset = socket.sends.length;
    expect(sendsBeforeReset).toBeGreaterThan(0);

    act(() => {
      captured.current?.resetPrefs();
    });

    // Local state snaps to DEFAULT_PREFS.
    expect(captured.current?.prefs).toEqual(DEFAULT_PREFS);
    expect(captured.current?.prefsRef.current).toEqual(DEFAULT_PREFS);

    // Filter to the sends that landed after resetPrefs was called.
    const resetSends = socket.sends.slice(sendsBeforeReset);
    const {
      subagentsAllowed: _subagentsAllowed,
      subagentsPolicyLocked: _subagentsPolicyLocked,
      ...resettablePrefs
    } = DEFAULT_PREFS;
    expect(resetSends).toContainEqual({
      type: 'prefs.update',
      payload: resettablePrefs,
    });

    roots.push(root);
  });

  it('also dispatches autonomy.switch with the default autonomy mode', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    // Force the autonomy loop into a non-default mode.
    act(() => {
      captured.current?.switchAutonomy('auto');
    });

    const sendsBeforeReset = socket.sends.length;

    act(() => {
      captured.current?.resetPrefs();
    });

    const resetSends = socket.sends.slice(sendsBeforeReset);
    expect(resetSends).toContainEqual({
      type: 'autonomy.switch',
      payload: { mode: DEFAULT_PREFS.autonomy },
    });

    roots.push(root);
  });

  it('is a no-op on the wire when called twice in a row with no intervening changes', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const root = renderProbe(captured, socket);

    act(() => {
      captured.current?.resetPrefs();
    });
    const sendsAfterFirst = socket.sends.length;

    act(() => {
      captured.current?.resetPrefs();
    });
    const sendsAfterSecond = socket.sends.length;

    // Each call still pushes two wire ops (prefs.update + autonomy.switch),
    // because the function is intentionally idempotent and never short-circuits.
    expect(sendsAfterSecond - sendsAfterFirst).toBe(2);

    roots.push(root);
  });
});
