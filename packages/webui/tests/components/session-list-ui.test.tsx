import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from '../../src/components/SidePanel/SessionList';
import { i18n } from '../../src/i18n';
import type { SessionHistoryEntry } from '../../src/stores';
import { useSessionTabStore, useUIStore } from '../../src/stores';
import { chatLane, DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes';
import { nestedButtons } from '../helpers/nested-buttons.js';

function entry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    id: 'session-1',
    title: 'Rebuild the WebUI',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    model: 'claude-sonnet',
    provider: 'anthropic',
    tokenTotal: 1_250,
    toolCallCount: 6,
    fileChangeCount: 3,
    outcome: 'completed',
    isCurrent: false,
    ...overrides,
  };
}

describe('SessionList workspace', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useUIStore.setState({ favoriteSessionIds: [], sessionNicknames: {} });
    useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  });

  afterEach(() => cleanup());

  function renderWorkspace(overrides: Partial<ComponentProps<typeof SessionList>> = {}) {
    const props: ComponentProps<typeof SessionList> = {
      historyQuery: '',
      setHistoryQuery: vi.fn(),
      historyEntries: [entry()],
      historyLoading: false,
      historyError: null,
      wsConnected: true,
      listSessions: vi.fn(),
      resumeSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      variant: 'workspace',
      ...overrides,
    };
    render(<SessionList {...props} />);
    return props;
  }

  it('renders operational stats, persistent search and history filters', () => {
    renderWorkspace();
    expect(screen.getByLabelText('Filter title, model, provider…')).toBeDefined();
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Tool calls')).toBeDefined();
    expect(screen.getByText('Files changed')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined();
  });

  it('constrains the workspace height so the session list owns vertical scrolling', () => {
    renderWorkspace();
    const workspace = document.querySelector<HTMLElement>('[data-history-variant="workspace"]');
    expect(workspace?.classList.contains('h-full')).toBe(true);
    expect(
      Array.from(workspace?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.classList.contains('overflow-y-auto'),
      ),
    ).toBe(true);
  });

  it('keeps rename editing outside the resume button and persists on Enter', () => {
    const props = renderWorkspace();
    fireEvent.click(screen.getByTitle('Rename'));
    const input = screen.getByLabelText('Session name');
    expect(input.closest('button')).toBeNull();
    fireEvent.change(input, { target: { value: 'Operator history' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.renameSession).toHaveBeenCalledWith('session-1', 'Operator history');
  });

  it('cancels an edited session name with Escape without saving', () => {
    const props = renderWorkspace();
    fireEvent.click(screen.getByTitle('Rename'));
    const input = screen.getByLabelText('Session name');
    fireEvent.change(input, { target: { value: 'Cancelled draft' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Session name')).toBeNull();
    expect(props.renameSession).not.toHaveBeenCalled();
  });

  it.each(['tokens', 'activity'])('preserves %s ordering across different time groups', (sort) => {
    const now = Date.now();
    renderWorkspace({
      historyEntries: [
        entry({ id: 'recent-small', tokenTotal: 10, toolCallCount: 1, fileChangeCount: 0 }),
        entry({
          id: 'older-large',
          tokenTotal: 9000,
          toolCallCount: 50,
          fileChangeCount: 8,
          startedAt: new Date(now - 40 * 86_400_000).toISOString(),
          endedAt: new Date(now - 40 * 86_400_000 + 60_000).toISOString(),
        }),
      ],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort sessions' }), {
      target: { value: sort },
    });
    expect(
      Array.from(document.querySelectorAll('[data-session-id]')).map((row) =>
        row.getAttribute('data-session-id'),
      ),
    ).toEqual(['older-large', 'recent-small']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort sessions' }), {
      target: { value: 'recent' },
    });
    expect(
      Array.from(document.querySelectorAll('[data-session-id]')).map((row) =>
        row.getAttribute('data-session-id'),
      ),
    ).toEqual(['recent-small', 'older-large']);
  });

  it('keeps the no-match state visible after switching to a metric sort', () => {
    renderWorkspace({ historyQuery: 'no-matching-conversation' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort sessions' }), {
      target: { value: 'tokens' },
    });
    expect(screen.getByText('No matches')).toBeDefined();
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(0);
  });

  it('retains pinned groups ahead of metric-ranked unpinned sessions', () => {
    useUIStore.setState({ favoriteSessionIds: ['pinned-small'] });
    renderWorkspace({
      historyEntries: [
        entry({ id: 'pinned-small', tokenTotal: 10 }),
        entry({ id: 'unpinned-large', tokenTotal: 9000 }),
      ],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort sessions' }), {
      target: { value: 'tokens' },
    });
    expect(
      Array.from(document.querySelectorAll('[data-session-id]')).map((row) =>
        row.getAttribute('data-session-id'),
      ),
    ).toEqual(['pinned-small', 'unpinned-large']);
  });

  it('pins locally and resumes through an explicit workspace action', () => {
    const props = renderWorkspace();
    fireEvent.click(screen.getByTitle('Mark as favorite'));
    expect(useUIStore.getState().favoriteSessionIds).toEqual(['session-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(props.resumeSession).toHaveBeenCalledWith('session-1');
  });

  it('opens a free tab and asks the backend to resume the selected history session', () => {
    const props = renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    expect(useSessionTabStore.getState().openTabIds).toEqual(['session-1']);
    expect(useSessionLanes.getState().activeSessionId).toBe('session-1');
    expect(props.resumeSession).toHaveBeenCalledExactlyOnceWith('session-1');
  });

  it('offers no Resume for a session that already owns a slot, and switches on the row', () => {
    useSessionTabStore.setState({
      openTabIds: ['session-active', 'session-1'],
      lastSeenCounts: {},
      attention: {},
    });
    useSessionLanes.setState({ activeSessionId: 'session-active' });
    useChatLanes.setState({ activeSessionId: 'session-active' });
    const props = renderWorkspace();

    // One session, one slot. A conversation that is already on screen cannot
    // be "resumed" — the tab holds the richer record, and re-reading it from
    // disk would replace live tool cards and audit markers with a plainer
    // replay. Offering the button promised exactly that, so it is not there.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    // The row itself is the switch affordance, and the badge says where it is.
    expect(screen.getByText('Tab 2')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Rebuild the WebUI/ }));

    expect(useSessionTabStore.getState().openTabIds).toEqual(['session-active', 'session-1']);
    expect(useSessionLanes.getState().activeSessionId).toBe('session-1');
    // The server hears `session.focus`, never a resume (see session-tab-store).
    expect(props.resumeSession).not.toHaveBeenCalled();
  });

  it('refuses a new resume when all four slots contain non-empty sessions', () => {
    useSessionTabStore.setState({
      openTabIds: ['tab-a', 'tab-b', 'tab-c', 'tab-d'],
      lastSeenCounts: {},
      attention: {},
    });
    useSessionLanes.setState({ activeSessionId: 'tab-a' });
    useChatLanes.setState({ activeSessionId: 'tab-a' });
    for (const id of ['tab-a', 'tab-b', 'tab-c', 'tab-d']) {
      chatLane(id).addMessage({ role: 'user', content: id });
    }
    const props = renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a', 'tab-b', 'tab-c', 'tab-d']);
    expect(useSessionLanes.getState().activeSessionId).toBe('tab-a');
    expect(props.resumeSession).not.toHaveBeenCalled();
  });

  it('paginates long workspace histories', () => {
    renderWorkspace({
      historyEntries: Array.from({ length: 21 }, (_, index) =>
        entry({ id: `session-${index + 1}`, title: `Session ${index + 1}` }),
      ),
    });
    expect(screen.getByText('1–20 of 21 sessions')).toBeDefined();
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('21–21 of 21 sessions')).toBeDefined();
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(1);
  });

  it('balances the workspace columns around one continuous timeline per page', () => {
    // Anchor buckets to local midnight so the assertions hold at any hour:
    // positive offsets are always "today", small negatives "yesterday".
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const at = (offsetMs: number) => new Date(midnight.getTime() + offsetMs).toISOString();
    const MIN = 60_000;
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    renderWorkspace({
      historyEntries: [
        entry({ id: 'today-b', startedAt: at(5 * MIN), endedAt: at(6 * MIN) }),
        entry({ id: 'today-a', startedAt: at(2 * MIN), endedAt: at(3 * MIN) }),
        entry({ id: 'yest-a', startedAt: at(-2 * HOUR), endedAt: at(-2 * HOUR + 30 * MIN) }),
        entry({ id: 'yest-b', startedAt: at(-3 * HOUR), endedAt: at(-3 * HOUR + 30 * MIN) }),
        entry({ id: 'old-a', startedAt: at(-40 * DAY), endedAt: at(-40 * DAY + 30 * MIN) }),
        entry({ id: 'old-b', startedAt: at(-41 * DAY), endedAt: at(-41 * DAY + 30 * MIN) }),
      ],
    });

    const columns = Array.from(document.querySelectorAll('[data-history-column]'));
    expect(columns).toHaveLength(2);
    const idsOf = (column: Element | undefined) =>
      column
        ? Array.from(column.querySelectorAll('[data-session-id]')).map((row) =>
            row.getAttribute('data-session-id'),
          )
        : [];
    // The left column carries the newest half of the page and the right
    // column the older half — one continuous timeline, both balanced 3/3,
    // instead of groups zigzagging left/right down the page.
    expect(idsOf(columns[0])).toEqual(['today-b', 'today-a', 'yest-a']);
    expect(idsOf(columns[1])).toEqual(['yest-b', 'old-a', 'old-b']);
  });

  it('keeps the visible rows on screen when the history shrinks under a selected page', () => {
    const props = {
      historyQuery: '',
      setHistoryQuery: vi.fn(),
      historyLoading: false,
      historyError: null,
      wsConnected: true,
      listSessions: vi.fn(),
      resumeSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      variant: 'workspace' as const,
      historyEntries: Array.from({ length: 21 }, (_, index) =>
        entry({
          id: `session-${index + 1}`,
          title: `Session ${index + 1}`,
          startedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        }),
      ),
    };
    const view = render(<SessionList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(1);

    // The list shrinks to five while page 2 is selected: without clamping
    // the stale page slices past the end and blanks the grid.
    view.rerender(<SessionList {...props} historyEntries={props.historyEntries.slice(0, 5)} />);
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(5);
  });

  it('badges the clear-empty control with the removable count when empty sessions exist', () => {
    // Never-started records are no longer auto-deleted on tab close, so this
    // control is the only signal that clearable empty sessions exist. The
    // count must be visible in every variant, not just workspace mode.
    renderWorkspace({
      historyEntries: [
        entry({ id: 'session-empty-1', tokenTotal: 0 }),
        entry({ id: 'session-empty-2', tokenTotal: 0 }),
        entry(), // session-1 has tokens → not removable
      ],
    });

    // Same i18n call the component makes, so the assertion survives locale
    // edits: the accessible name carries the count via aria-label/title.
    const name = i18n.t('activity:sessions.deleteEmptyTitle', { count: 2 }) as string;
    const button = screen.getByRole('button', { name });

    // The count badge is the button's only text content (icon is an svg).
    expect(button.textContent).toContain('2');
  });

  it('hides the clear-empty control when every session has content', () => {
    renderWorkspace({
      historyEntries: [entry(), entry({ id: 'session-2', tokenTotal: 900 })],
    });

    expect(
      screen.queryByRole('button', {
        name: i18n.t('activity:sessions.deleteEmptyTitle', { count: 0 }) as string,
      }),
    ).toBeNull();
  });

  it('renders no button nested inside another button', () => {
    // The history row is itself a button and carries inline actions (rename,
    // pin, Resume, tab badge) plus a rename editor. Each has to stay a sibling
    // of the row: nesting them is invalid HTML, and an inner control's
    // activation becomes undefined in a real browser.
    renderWorkspace();
    const workspace = document.querySelector<HTMLElement>('[data-history-variant="workspace"]');
    expect(workspace).not.toBeNull();
    expect(nestedButtons(workspace as HTMLElement)).toEqual([]);

    // Opening the rename editor is the phase that swaps a control into the row.
    fireEvent.click(screen.getByTitle('Rename'));
    expect(screen.getByLabelText('Session name')).toBeDefined();
    expect(nestedButtons(workspace as HTMLElement)).toEqual([]);
  });
});
