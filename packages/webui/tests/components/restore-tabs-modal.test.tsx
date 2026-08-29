import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resumeSessionById = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ resumeSessionById, send: vi.fn(), subscribeSessions: vi.fn() }),
}));

import { RestoreTabsModal } from '../../src/components/RestoreTabsModal';
import { useHistoryStore } from '../../src/stores/history-store';
import { useRestoreTabsStore } from '../../src/stores/restore-tabs-store';
import { MAX_OPEN_TABS, useSessionTabStore } from '../../src/stores/session-tab-store';

/**
 * The offer a fresh WebUI makes about the tabs the browser remembers.
 *
 * The contract in one line: a WebUI that starts fresh IS fresh, and the old
 * sessions are a QUESTION — never something that reopens itself. Doing nothing
 * (Escape, "Start fresh") must leave the user on the single new session.
 */

const openTab = vi.fn(() => ({ success: true }) as never);

beforeEach(() => {
  resumeSessionById.mockClear();
  openTab.mockClear();
  useRestoreTabsStore.setState({ candidates: [] });
  useHistoryStore.setState({ entries: [] } as never);
  useSessionTabStore.setState({ openTabIds: ['sess-new'], lastSeenCounts: {}, attention: {} });
  useSessionTabStore.setState({ openTab } as never);
});

describe('RestoreTabsModal', () => {
  it('renders nothing when the runtime kept every tab', () => {
    const { container } = render(<RestoreTabsModal />);
    expect(container.innerHTML).toBe('');
  });

  it('names the offered sessions, using history titles when they have arrived', () => {
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-old-a',
          title: 'Refactor the proxy wiring',
          startedAt: '2026-08-28T10:00:00Z',
          model: 'opus',
          provider: 'anthropic',
          tokenTotal: 1,
          messageCount: 42,
          isCurrent: false,
        },
      ],
    } as never);
    useRestoreTabsStore.setState({ candidates: ['sess-old-a', 'sess-old-b'] });

    render(<RestoreTabsModal />);

    expect(screen.getByText('Refactor the proxy wiring')).toBeTruthy();
    expect(screen.getByText(/42 messages/)).toBeTruthy();
    // No history row yet — the id still identifies it rather than blocking the
    // modal on the `sessions.list` frame.
    expect(screen.getAllByText(/sess-old-b/).length).toBeGreaterThan(0);
  });

  it('reopens exactly the ticked sessions through the normal open path', () => {
    useRestoreTabsStore.setState({ candidates: ['sess-old-a', 'sess-old-b'] });
    render(<RestoreTabsModal />);

    // Both preselected (they fit); untick the first so only one comes back.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    fireEvent.click(boxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Reopen/ }));

    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith('sess-old-b', expect.anything());
    expect(useRestoreTabsStore.getState().candidates).toEqual([]);
  });

  it('"Start fresh" reopens nothing and clears the offer', () => {
    useRestoreTabsStore.setState({ candidates: ['sess-old-a'] });
    render(<RestoreTabsModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));

    expect(openTab).not.toHaveBeenCalled();
    expect(resumeSessionById).not.toHaveBeenCalled();
    expect(useRestoreTabsStore.getState().candidates).toEqual([]);
  });

  it('never lets the strip exceed the tab ceiling', () => {
    // One tab is already open (the fresh boot session), so only
    // MAX_OPEN_TABS - 1 of the offered sessions may be ticked.
    const offered = Array.from({ length: MAX_OPEN_TABS + 2 }, (_, i) => `sess-old-${i}`);
    useRestoreTabsStore.setState({ candidates: offered });

    render(<RestoreTabsModal />);

    const checked = (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter(
      (box) => box.checked,
    );
    expect(checked).toHaveLength(MAX_OPEN_TABS - 1);
    expect(screen.getByText(/At most/)).toBeTruthy();
  });
});
