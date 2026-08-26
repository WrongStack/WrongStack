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
        cwd: '/project',
        createdAt: new Date().toISOString(),
      },
    });
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-12345678',
          name: 'Initial Session',
          title: 'Initial Session',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'sess-87654321',
          name: 'Secondary Session',
          title: 'Secondary Session',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
