import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorPanel } from '../../src/components/InspectorPanel';
import { useFleetStore, useKanbanStore, useUIStore } from '../../src/stores';
import { DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import {
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import type { FleetTimelineEvent, SubagentView } from '../../src/stores/types';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, opts?: any) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return opts.defaultValue;
      return k;
    },
  }),
  i18n: {
    t: (k: string) => k,
  },
}));

function agent(id: string, sessionId: string): SubagentView {
  return {
    id,
    sessionId,
    name: id,
    status: 'running',
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

function event(id: string, agentId: string, message: string): FleetTimelineEvent {
  return {
    id,
    agentId,
    agentName: agentId,
    kind: 'tool_executed',
    timestamp: Date.now(),
    message,
  };
}

describe('InspectorPanel component with universal targets', () => {
  beforeEach(() => {
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
    useFleetStore.setState({
      agents: new Map(),
      leaderId: undefined,
      eventTimeline: [],
    });
    useUIStore.setState({
      inspectorOpen: true,
      inspectorTab: 'fleet',
      inspectorTarget: null,
    });
    useKanbanStore.setState({
      activeBoard: {
        id: 'board-1',
        title: 'Core Sprint',
        columns: [],
        tasks: [
          {
            id: 'task-101',
            title: 'Fix authentication cookie issue',
            description: 'Cookies must have SameSite=Lax and Secure in prod.',
            columnId: 'todo',
            priority: 'high',
            assignedAgent: 'agent-sec-1',
          },
        ] as any,
      } as any,
    });
  });

  it('renders standard fleet tabs when no task target is set', () => {
    render(<InspectorPanel />);

    expect(screen.getByTestId('inspector-drawer')).toBeDefined();
  });

  it('filters the fleet event timeline to the active session', () => {
    setActiveSessionLane('sess-a');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['agent-a', agent('agent-a', 'sess-a')],
        ['agent-b', agent('agent-b', 'sess-b')],
      ]),
      eventTimeline: [
        event('event-a', 'agent-a', 'event from active session'),
        event('event-b', 'agent-b', 'event from other session'),
      ],
    } as never);

    render(<InspectorPanel />);

    expect(screen.getByText('event from active session')).toBeDefined();
    expect(screen.queryByText('event from other session')).toBeNull();
  });

  it('renders task details and back button when task target is set', () => {
    useUIStore.getState().openInspectorTarget({
      kind: 'task',
      taskId: 'task-101',
      title: 'Fix authentication cookie issue',
    });

    render(<InspectorPanel />);

    const titles = screen.getAllByText('Fix authentication cookie issue');
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('agent-sec-1')).toBeDefined();
    expect(screen.getByText('Cookies must have SameSite=Lax and Secure in prod.')).toBeDefined();

    // Clicking Back button returns to fleet view
    const backBtn = screen.getByTitle('Back to Fleet');
    fireEvent.click(backBtn);

    expect(useUIStore.getState().inspectorTarget).toEqual({ kind: 'fleet', tab: 'fleet' });
  });
});
