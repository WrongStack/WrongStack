import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTabBar } from '../../src/components/SessionTabBar';
import { useHistoryStore, useSessionStore } from '../../src/stores';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store';

const mockResumeSession = vi.fn();
const mockNewSession = vi.fn();
const mockListSessions = vi.fn();

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, d?: string) => d ?? k,
  }),
}));

vi.mock('../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    resumeSession: mockResumeSession,
    newSession: mockNewSession,
    listSessions: mockListSessions,
  }),
}));

describe('SessionTabBar component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      session: {
        id: 'sess-12345678',
        title: 'Initial Session',
        startedAt: Date.now(),
        provider: 'test',
        model: 'test-model',
      },
    });
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-12345678',
          name: 'Initial Session',
          title: 'Initial Session',
          startedAt: new Date().toISOString(),
          model: 'test-model',
          provider: 'test',
          tokenTotal: 0,
          isCurrent: true,
        },
        {
          id: 'sess-87654321',
          name: 'Secondary Session',
          title: 'Secondary Session',
          startedAt: new Date().toISOString(),
          model: 'test-model',
          provider: 'test',
          tokenTotal: 0,
          isCurrent: false,
        },
      ],
    });
    useSystemPromptStore.setState({ pickerOpen: false, pickerStartsSession: false });
  });

  it('renders active session tab', () => {
    render(<SessionTabBar />);

    expect(screen.getByText('Initial Session')).toBeDefined();
  });

  it('triggers new session creation when + button is clicked', () => {
    render(<SessionTabBar />);

    const newBtn = screen.getByTitle('New Session');
    fireEvent.click(newBtn);

    expect(useSystemPromptStore.getState().pickerOpen).toBe(true);
    expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
  });
});
