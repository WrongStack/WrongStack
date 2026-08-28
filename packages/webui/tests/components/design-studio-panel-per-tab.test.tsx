/**
 * The Design Studio side panel is the SECOND surface for `design.*`.
 *
 * The gallery view has named its tab since the four-tab work; this panel had
 * not. The active kit lives on that session's `meta.designStudio`, which
 * shapes its system prompt — so an unstamped `design.use` from a background
 * tab re-styled whichever conversation the runtime was pointing at, and an
 * unstamped `design.list` showed this tab another tab's active kit.
 *
 * The WS client is mocked: `send` is captured, and registered `on(type, …)`
 * handlers are invoked manually to simulate server pushes.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sends: { type: string; payload?: unknown }[] = [];
const handlers: Record<string, (m: unknown) => void> = {};
const mockClient = {
  send: (m: { type: string; payload?: unknown }) => {
    sends.push(m);
  },
  withSession: <T extends Record<string, unknown>>(p: T) => ({
    ...p,
    sessionId: activeSessionLaneId(),
  }),
  on: (type: string, h: (m: unknown) => void) => {
    handlers[type] = h;
  },
  off: (type: string) => {
    delete handlers[type];
  },
};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: mockClient }),
}));

import { DesignStudioPanel } from '../../src/components/SidePanel/DesignStudioPanel.js';
import {
  activeSessionLaneId,
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';

function emit(type: string, payload: unknown): void {
  act(() => handlers[type]?.({ type, payload }));
}

const KIT = {
  id: 'kit-one',
  name: 'Kit One',
  aesthetic: 'Test aesthetic',
  bestFor: 'Testing',
  stacks: ['web'],
  tags: ['test'],
  light: { bg: '#ffffff', fg: '#111111', primary: '#2244ff' },
  dark: { bg: '#000000', fg: '#eeeeee', primary: '#88aaff' },
};

beforeEach(() => {
  sends.length = 0;
  for (const key of Object.keys(handlers)) delete handlers[key];
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  ensureSessionLane('tab-1');
  ensureSessionLane('tab-2');
  setActiveSessionLane('tab-1');
});

describe('DesignStudioPanel names its tab', () => {
  it('asks for the kit list as this session', () => {
    render(<DesignStudioPanel />);
    const list = sends.find((s) => s.type === 'design.list');
    expect(list?.payload).toMatchObject({ sessionId: 'tab-1' });
  });

  it('pins a kit on this session, not the runtime’s', () => {
    render(<DesignStudioPanel />);
    emit('design.list', { kits: [KIT], activeKit: null, sessionId: 'tab-1' });

    fireEvent.click(screen.getByRole('button', { name: /use/i }));

    const use = sends.find((s) => s.type === 'design.use');
    expect(use?.payload).toMatchObject({ kit: 'kit-one', sessionId: 'tab-1' });
  });

  it('ignores a list that belongs to another tab', () => {
    render(<DesignStudioPanel />);
    emit('design.list', { kits: [KIT], activeKit: 'kit-one', sessionId: 'tab-2' });

    // Nothing from tab-2 is rendered: the panel is still waiting for its own.
    expect(screen.queryByText('Kit One')).toBeNull();
  });

  it('re-reads when the user switches tabs', () => {
    const view = render(<DesignStudioPanel />);
    sends.length = 0;

    act(() => setActiveSessionLane('tab-2'));
    view.rerender(<DesignStudioPanel />);

    // The panel is parked, not unmounted, so without the re-ask it would keep
    // showing (and pinning against) the previous tab's kit.
    const list = sends.filter((s) => s.type === 'design.list');
    expect(list.at(-1)?.payload).toMatchObject({ sessionId: 'tab-2' });
  });
});
