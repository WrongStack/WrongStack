/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabPanel, forgetCollabSession } from '../src/collab/CollabPanel.js';

const translation = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));
vi.mock('../src/lib/i18n', () => ({
  displayLocale: () => 'en',
  useAppTranslation: () => translation,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  forgetCollabSession('s1');
  forgetCollabSession('s2');
  container?.remove();
  root = null;
  container = null;
});

describe('CollabPanel session parking, error scoping, and null payload guards', () => {
  it('preserves parked session participants across unmount/remount until forgetCollabSession is called', async () => {
    const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();
    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };
    const client = {
      on(type: string, handler: (msg: { type: string; payload: unknown }) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
        return () => set.delete(handler);
      },
      send() {},
    };

    await act(async () => {
      root?.render(<CollabPanel sessionId="s1" client={client} pendingTools={[]} />);
    });
    await act(async () => {
      emit('collab.state', {
        sessionId: 's1',
        participants: [
          { participantId: 'alice', role: 'observer', joinedAt: '2026-11-19T00:00:00Z' },
        ],
      });
    });
    expect(container?.textContent).not.toContain('noObservers');

    // Unmount and remount on s1 -> parked participants remain intact
    await act(async () => {
      root?.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root?.render(<CollabPanel sessionId="s1" client={client} pendingTools={[]} />);
    });
    expect(container?.textContent).not.toContain('noObservers');

    // Forget s1, unmount, remount -> empty state restored
    await act(async () => {
      forgetCollabSession('s1');
      root?.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root?.render(<CollabPanel sessionId="s1" client={client} pendingTools={[]} />);
    });
    expect(container?.textContent).toContain('noObservers');
  });

  it('ignores foreign-session collab errors and handles null/primitive event payloads safely', async () => {
    const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();
    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };
    const client = {
      on(type: string, handler: (msg: { type: string; payload: unknown }) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
        return () => set.delete(handler);
      },
      send() {},
    };

    await act(async () => {
      root?.render(<CollabPanel sessionId="s1" client={client} pendingTools={[]} />);
    });

    for (const evType of [
      'collab.state',
      'collab.participant.joined',
      'collab.participant.left',
      'error',
      'collab.annotation.added',
      'collab.annotation.resolved',
      'collab.pause.granted',
      'collab.pause.released',
    ]) {
      await act(async () => {
        emit(evType, null);
        emit(evType, 'bad');
      });
    }

    await act(async () => {
      emit('error', { phase: 'collab', sessionId: 's2', message: 'foreign-error' });
    });
    expect(container?.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      emit('error', { phase: 'collab', sessionId: 's1', message: 'own-error' });
    });
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('own-error');
  });
});
