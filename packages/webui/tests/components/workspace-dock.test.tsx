import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDock } from '../../src/components/WorkspaceDock';
import { useFleetStore, useSessionStore, useUIStore } from '../../src/stores';
import { DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import type { SubagentView } from '../../src/stores/types';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (_key: string, fallback?: string | { defaultValue?: string; label?: string }) => {
      if (typeof fallback === 'string') return fallback;
      return fallback?.defaultValue ?? fallback?.label ?? _key.split('.').at(-1) ?? _key;
    },
  }),
}));

const gitInfo = vi.hoisted(() => ({ current: null as unknown }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/portable-command-rpc', () => ({ invokePortableCommand: rpc }));
vi.mock('../../src/hooks/useGitInfo', () => ({
  useGitInfo: () => gitInfo.current,
}));

function agent(id: string, sessionId: string, status: SubagentView['status']): SubagentView {
  return {
    id,
    sessionId,
    name: id,
    status,
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
    sparklineBins: [],
  };
}

beforeEach(() => {
  rpc.mockResolvedValue({
    message: JSON.stringify({ projectId: 'p', pending: 0, total: 0, version: 'a'.repeat(64) }),
  });
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useUIStore.setState({ dockSection: null, hiddenChips: [], dockCustomizeOpen: false });
  useSessionStore.setState({ todos: [] });
  useFleetStore.setState({ agents: new Map() } as never);
  gitInfo.current = null;
  // The Fleet chip is full chrome; calm chrome sends agents to the inspector.
  useLocalPrefs.setState({ chromeLevel: 'full' });
});

describe('WorkspaceDock', () => {
  it('shows pending ADRs while the panel is closed and opens the review inbox', async () => {
    setActiveSessionLane('sess-a');
    rpc.mockResolvedValue({
      message: JSON.stringify({ projectId: 'p', pending: 3, total: 5, version: 'b'.repeat(64) }),
    });
    render(<WorkspaceDock />);
    const chip = screen.getByRole('button', { name: /shortTitle/ });
    await waitFor(() => expect(chip.textContent).toContain('3'));
    fireEvent.click(chip);
    expect(useUIStore.getState().dockSection).toBe('adr');
  });
  it('counts only the active session fleet in the Fleet chip', () => {
    setActiveSessionLane('sess-a');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['a-running', agent('a-running', 'sess-a', 'running')],
        ['a-done', agent('a-done', 'sess-a', 'completed')],
        ['b-running', agent('b-running', 'sess-b', 'running')],
      ]),
    } as never);

    render(<WorkspaceDock />);

    expect(screen.getByRole('button', { name: /fleet/i }).textContent).toContain('1/2');
  });

  it('calm chrome offers no Fleet chip (agents live in the right inspector)', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    setActiveSessionLane('sess-a');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['a-running', agent('a-running', 'sess-a', 'running')],
      ]),
    } as never);

    render(<WorkspaceDock />);

    expect(screen.queryByRole('button', { name: /fleet/i })).toBeNull();
  });

  it('hides the Fleet chip when only other tabs have agents', () => {
    setActiveSessionLane('sess-a');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['b-running', agent('b-running', 'sess-b', 'running')],
      ]),
    } as never);

    render(<WorkspaceDock />);

    expect(screen.queryByRole('button', { name: /fleet/i })).toBeNull();
  });

  it('shows the git chip for a repository and hides it when there is no branch', () => {
    const counts = { added: 3, deleted: 1, untracked: 0, ahead: 0, behind: 0, fetchedAt: 0 };
    gitInfo.current = { branch: 'main', ...counts };
    const { unmount } = render(<WorkspaceDock />);
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
    unmount();

    // Not a git repository: the server sends an empty branch; no chip (it
    // used to read "(detached)" with counters).
    gitInfo.current = { branch: '', ...counts };
    render(<WorkspaceDock />);
    expect(screen.queryByText('+3')).toBeNull();
  });
});
