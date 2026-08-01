// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type UseWorklistsResult, useWorklists } from '../src/hooks/use-worklists.js';
import type { SimpleSocket } from '../src/lib/ws.js';

/**
 * Behavior coverage for the `useWorklists` hook (plan B1 slice 4, extracted
 * from simple-ui-session.tsx). Pins the wire op for every command, the
 * no-op-without-session guard, the bounded `simpleui:open-workspace-panel`
 * CustomEvent dispatch, and the stable callback identities.
 *
 * Harness mirrors `use-simple-mailbox.test.tsx`: jsdom + real `createRoot`
 * + `act`, no testing-library dependency.
 */

interface RecordedSend {
  type: string;
  payload: Record<string, unknown>;
}

interface Captured {
  current: UseWorklistsResult | null;
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

function makeSessionIdRef(initial: string | null): React.MutableRefObject<string | null> {
  return { current: initial };
}

function renderProbe(
  captured: Captured,
  socket: ReturnType<typeof makeSocketStub>,
  sessionIdRef: React.MutableRefObject<string | null>,
): { root: Root; rerender: () => void } {
  function Probe(): null {
    captured.current = useWorklists({ socketRef: socket.ref, sessionIdRef });
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return {
    root,
    rerender: () =>
      act(() => {
        root.render(<Probe />);
      }),
  };
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('useWorklists — worklist store', () => {
  it('creates the worklist store with a null session id initially', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef('s-1'));
    expect(captured.current?.worklists.getSnapshot().sessionId).toBeNull();
    roots.push(root);
  });
});

describe('useWorklists — requestWorklist', () => {
  it('maps each view to its wire op with the active session id', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef('s-1'));

    act(() => {
      captured.current?.requestWorklist('todos');
    });
    act(() => {
      captured.current?.requestWorklist('tasks');
    });
    act(() => {
      captured.current?.requestWorklist('plan');
    });

    expect(socket.sends).toEqual([
      { type: 'todos.get', payload: { sessionId: 's-1' } },
      { type: 'tasks.get', payload: { sessionId: 's-1' } },
      { type: 'plan.get', payload: { sessionId: 's-1' } },
    ]);
    roots.push(root);
  });

  it('is a no-op without an active session id', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef(null));

    act(() => {
      captured.current?.requestWorklist('todos');
    });
    expect(socket.sends).toHaveLength(0);
    roots.push(root);
  });

  it('reads the session id at call time (live ref, not a stale closure)', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const sessionIdRef = makeSessionIdRef(null);
    const { root } = renderProbe(captured, socket, sessionIdRef);

    act(() => {
      captured.current?.requestWorklist('plan');
    });
    expect(socket.sends).toHaveLength(0);

    sessionIdRef.current = 's-2';
    act(() => {
      captured.current?.requestWorklist('plan');
    });
    expect(socket.sends).toEqual([{ type: 'plan.get', payload: { sessionId: 's-2' } }]);
    roots.push(root);
  });
});

describe('useWorklists — status updaters', () => {
  it('sends the correct wire op for each status updater', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef('s-1'));

    act(() => {
      captured.current?.updateTodoStatus('t-1', 'in_progress');
    });
    act(() => {
      captured.current?.updateTaskStatus('k-1', 'in_progress');
    });
    act(() => {
      captured.current?.updatePlanStatus('p-1', 'done');
    });

    expect(socket.sends).toEqual([
      { type: 'todo.update', payload: { sessionId: 's-1', id: 't-1', status: 'in_progress' } },
      { type: 'task.update', payload: { sessionId: 's-1', id: 'k-1', status: 'in_progress' } },
      { type: 'plan.item.update', payload: { sessionId: 's-1', target: 'p-1', status: 'done' } },
    ]);
    roots.push(root);
  });

  it('is a no-op without an active session id', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef(null));

    act(() => {
      captured.current?.updateTodoStatus('t-1', 'completed');
    });
    act(() => {
      captured.current?.updatePlanStatus('p-1', 'done');
    });
    expect(socket.sends).toHaveLength(0);
    roots.push(root);
  });
});

describe('useWorklists — openWorkspacePanel', () => {
  it('dispatches the bounded custom event with the view detail', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root } = renderProbe(captured, socket, makeSessionIdRef('s-1'));
    const received: Array<CustomEvent<{ view: string }>> = [];
    const handler = (event: Event) => {
      received.push(event as CustomEvent<{ view: string }>);
    };
    window.addEventListener('simpleui:open-workspace-panel', handler);
    try {
      act(() => {
        captured.current?.openWorkspacePanel('todos');
      });
      act(() => {
        captured.current?.openWorkspacePanel('tools');
      });
      expect(received).toHaveLength(2);
      expect(received[0]?.type).toBe('simpleui:open-workspace-panel');
      expect(received[0]?.detail.view).toBe('todos');
      expect(received[1]?.detail.view).toBe('tools');
    } finally {
      window.removeEventListener('simpleui:open-workspace-panel', handler);
    }
    roots.push(root);
  });
});

describe('useWorklists — stable identities', () => {
  it('keeps callback identities stable across renders (ref deps)', () => {
    const captured: Captured = { current: null };
    const socket = makeSocketStub();
    const { root, rerender } = renderProbe(captured, socket, makeSessionIdRef('s-1'));
    const first = captured.current;
    expect(first).not.toBeNull();

    rerender();
    const second = captured.current;
    expect(second).not.toBeNull();

    expect(second?.requestWorklist).toBe(first?.requestWorklist);
    expect(second?.openWorkspacePanel).toBe(first?.openWorkspacePanel);
    expect(second?.updateTodoStatus).toBe(first?.updateTodoStatus);
    expect(second?.updateTaskStatus).toBe(first?.updateTaskStatus);
    expect(second?.updatePlanStatus).toBe(first?.updatePlanStatus);
    roots.push(root);
  });
});
