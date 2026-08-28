import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from '../../src/components/SidePanel/SessionList';
import { i18n } from '../../src/i18n';
import type { SessionHistoryEntry } from '../../src/stores';
import { useSessionTabStore, useUIStore } from '../../src/stores';
import { chatLane, DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes';

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

  it('switches an already-open background tab and still asks the backend for its replay', () => {
    useSessionTabStore.setState({
      openTabIds: ['session-active', 'session-1'],
      lastSeenCounts: {},
      attention: {},
    });
    useSessionLanes.setState({ activeSessionId: 'session-active' });
    useChatLanes.setState({ activeSessionId: 'session-active' });
    const props = renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    expect(useSessionTabStore.getState().openTabIds).toEqual(['session-active', 'session-1']);
    expect(useSessionLanes.getState().activeSessionId).toBe('session-1');
    expect(props.resumeSession).toHaveBeenCalledExactlyOnceWith('session-1');
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
});
