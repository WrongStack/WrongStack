import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the socket; keep the real wire so the request/reply contract is what
// the test drives.
const send = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send }) }));

import { CompanionAgentsSection } from '../../src/components/SettingsPanel/CompanionAgentsSection';
import { handleKanbanCompanionStatus } from '../../src/lib/kanban-companion-wire';
import { useConfigStore } from '../../src/stores/config-store';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useSessionStore } from '../../src/stores/session-store';

function framesOf(type: string): Array<Record<string, unknown>> {
  return send.mock.calls
    .map((call) => call[0] as { type: string; payload: Record<string, unknown> })
    .filter((frame) => frame.type === type)
    .map((frame) => frame.payload);
}

let projectSeq = 0;

beforeEach(() => {
  send.mockClear();
  useConfigStore.setState({ wsStatus: { state: 'open' } });
  useLocalPrefs.getState().set({
    memoryCompanionEnabled: false,
    exploreCompanionEnabled: false,
    skillCompanionEnabled: false,
  });
  // Unique project per test so the hook performs a fresh kanban.companion.get.
  projectSeq += 1;
  useSessionStore.getState().setEnv({ projectRoot: `D:/proj-${projectSeq}` });
});

afterEach(cleanup);

describe('CompanionAgentsSection kanban companion', () => {
  it('renders the personal toggles plus the separate project-wide switch', () => {
    render(<CompanionAgentsSection syncPref={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Memory Companion' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Explore Companion' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Skill Companion' })).toBeTruthy();
    const kanban = screen.getByTestId('settings-kanban-companion-switch');
    expect(kanban.getAttribute('aria-checked')).toBe('false');
  });

  it('routes the kanban switch through kanban.companion.set, never through syncPref', () => {
    const syncPref = vi.fn();
    render(<CompanionAgentsSection syncPref={syncPref} />);

    const kanban = screen.getByTestId('settings-kanban-companion-switch');
    fireEvent.click(kanban);
    expect(syncPref).not.toHaveBeenCalled();
    const sets = framesOf('kanban.companion.set');
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ enabled: true });
    expect(typeof sets[0]!['requestId']).toBe('string');
    // Non-optimistic: unknown until the server confirms.
    expect(kanban.getAttribute('aria-checked')).toBe('false');
    expect(kanban.hasAttribute('disabled')).toBe(true);

    act(() => {
      handleKanbanCompanionStatus({
        success: true,
        data: { enabled: true },
        requestId: sets[0]!['requestId'],
      });
    });
    expect(kanban.getAttribute('aria-checked')).toBe('true');
    expect(kanban.hasAttribute('disabled')).toBe(false);

    // A personal companion still goes through syncPref, untouched by kanban.
    fireEvent.click(screen.getByRole('switch', { name: 'Memory Companion' }));
    expect(syncPref).toHaveBeenCalledWith('memoryCompanionEnabled', true);
    expect(framesOf('kanban.companion.set')).toHaveLength(1);
  });

  it('shows the error line when the server rejects the write', () => {
    render(<CompanionAgentsSection syncPref={vi.fn()} />);
    const kanban = screen.getByTestId('settings-kanban-companion-switch');

    fireEvent.click(kanban);
    const sets = framesOf('kanban.companion.set');
    act(() => {
      handleKanbanCompanionStatus({
        success: false,
        error: 'kanban offline',
        requestId: sets[0]!['requestId'],
      });
    });
    expect(screen.getByTestId('settings-kanban-companion-error').textContent).toBe(
      'kanban offline',
    );
    expect(kanban.getAttribute('aria-checked')).toBe('false');
    expect(kanban.hasAttribute('disabled')).toBe(false);
  });
});
