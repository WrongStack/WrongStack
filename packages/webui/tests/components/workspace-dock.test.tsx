import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDock } from '../../src/components/WorkspaceDock';
import { useFleetStore, useSessionStore, useUIStore } from '../../src/stores';
import { DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
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

vi.mock('../../src/hooks/useGitInfo', () => ({
  useGitInfo: () => null,
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
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useUIStore.setState({ dockSection: null, hiddenChips: [], dockCustomizeOpen: false });
  useSessionStore.setState({ todos: [] });
  useFleetStore.setState({ agents: new Map() } as never);
});

describe('WorkspaceDock', () => {
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
});
