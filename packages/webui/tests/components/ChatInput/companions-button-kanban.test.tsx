import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The composer talks to the socket through `useWebSocket` → ws-client, and the
// kanban wire through ws-client too. Stub the socket; keep the real stores and
// the real wire so the correlation contract is exercised end to end.
const send = vi.fn();
const updatePrefs = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send, updatePrefs }) }));

import { CompanionsButton } from '../../../src/components/ChatInput/companions-button';
import { handleKanbanCompanionStatus } from '../../../src/lib/kanban-companion-wire';
import { useConfigStore } from '../../../src/stores/config-store';
import { useLocalPrefs } from '../../../src/stores/local-prefs';
import { useSessionStore } from '../../../src/stores/session-store';

/** The most recent outbound frame; fails the test when nothing was sent. */
function lastFrame(): { type: string; payload: Record<string, unknown> } {
  const call = send.mock.calls.at(-1);
  if (!call) throw new Error('expected an outbound frame');
  return call[0] as { type: string; payload: Record<string, unknown> };
}

function framesOf(type: string): Array<Record<string, unknown>> {
  return send.mock.calls
    .map((call) => call[0] as { type: string; payload: Record<string, unknown> })
    .filter((frame) => frame.type === type)
    .map((frame) => frame.payload);
}

let projectSeq = 0;

beforeEach(() => {
  send.mockClear();
  updatePrefs.mockClear();
  useConfigStore.setState({ wsStatus: { state: 'open' } });
  useLocalPrefs.getState().set({
    memoryCompanionEnabled: false,
    exploreCompanionEnabled: false,
    skillCompanionEnabled: false,
  });
  // Unique project per test — the hook keys its sync on (connection, project),
  // so a fresh root forces a fresh kanban.companion.get.
  projectSeq += 1;
  useSessionStore.getState().setEnv({ projectRoot: `D:/proj-${projectSeq}` });
});

afterEach(cleanup);

describe('CompanionsButton kanban companion', () => {
  it('syncs from the server on mount and renders the switch unknown until the reply', () => {
    render(<CompanionsButton />);
    const gets = framesOf('kanban.companion.get');
    expect(gets).toHaveLength(1);
    expect(typeof gets[0]!['requestId']).toBe('string');

    fireEvent.click(screen.getByTestId('composer-companions-button'));
    const sw = screen.getByTestId('composer-kanban-companion-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the personal toggle-all and the 3-way count apart from the kanban switch', () => {
    render(<CompanionsButton />);
    fireEvent.click(screen.getByTestId('composer-companions-button'));

    fireEvent.click(screen.getByTestId('composer-companions-toggle-all'));
    expect(updatePrefs).toHaveBeenCalledWith({
      memoryCompanionEnabled: true,
      exploreCompanionEnabled: true,
      skillCompanionEnabled: true,
    });
    expect(framesOf('kanban.companion.set')).toHaveLength(0);
    // The badge counts only the three personal companions.
    expect(screen.getByTestId('composer-companions-button').textContent).toContain('3/3');
    expect(
      screen.getByTestId('composer-kanban-companion-switch').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('flips only on the server reply (non-optimistic), then follows broadcasts', () => {
    render(<CompanionsButton />);
    fireEvent.click(screen.getByTestId('composer-companions-button'));
    const sw = screen.getByTestId('composer-kanban-companion-switch');

    fireEvent.click(sw);
    const sets = framesOf('kanban.companion.set');
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ enabled: true });
    const requestId = sets[0]!['requestId'];
    // Not optimistic: still unknown, and blocked while the write is in flight.
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.hasAttribute('disabled')).toBe(true);

    act(() => {
      handleKanbanCompanionStatus({ success: true, data: { enabled: true }, requestId });
    });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.hasAttribute('disabled')).toBe(false);

    // requestId-less broadcast — another client flipped the switch.
    act(() => {
      handleKanbanCompanionStatus({ success: true, data: { enabled: false } });
    });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('surfaces a server error without moving the switch', () => {
    render(<CompanionsButton />);
    fireEvent.click(screen.getByTestId('composer-companions-button'));
    const sw = screen.getByTestId('composer-kanban-companion-switch');

    fireEvent.click(sw);
    const { requestId } = lastFrame().payload;
    expect(lastFrame().type).toBe('kanban.companion.set');
    act(() => {
      handleKanbanCompanionStatus({ success: false, error: 'kanban offline', requestId });
    });
    expect(screen.getByText('kanban offline')).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.hasAttribute('disabled')).toBe(false);
  });

  it('re-syncs after a reconnect even though the project is unchanged', () => {
    render(<CompanionsButton />);
    expect(framesOf('kanban.companion.get')).toHaveLength(1);
    act(() => {
      useConfigStore.setState({ wsStatus: { state: 'closed' } });
    });
    act(() => {
      useConfigStore.setState({ wsStatus: { state: 'open' } });
    });
    expect(framesOf('kanban.companion.get')).toHaveLength(2);
    // The two gets must not share a requestId — the newer supersedes the older.
    const gets = framesOf('kanban.companion.get');
    expect(gets[0]!['requestId']).not.toBe(gets[1]!['requestId']);
  });
});
