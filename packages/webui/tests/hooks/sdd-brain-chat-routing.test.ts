import { EventBus } from '@wrongstack/contracts/kernel';
import { ObservableBrainArbiter } from '@wrongstack/core/coordination';
import { SddSupervisor } from '@wrongstack/sdd';
import { SddWizardWebSocketHandler } from '@wrongstack/webui-server/server/sdd-wizard-ws-handler.js';
import { registerSetupEventsPatternHandlers } from '@wrongstack/webui-server/server/setup-events-pattern-handlers.js';
import { createSetupEventSessionHelpers } from '@wrongstack/webui-server/server/setup-events-session-helpers.js';
import { broadcast } from '@wrongstack/webui-server/server/ws-utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => null }));

const { ensureLane, readLane, useChatLanes } = await import('../../src/stores/chat-lanes');
const { useSessionTabStore } = await import('../../src/stores/session-tab-store');
const { handleBrainEvent } = await import('../../src/hooks/ws-handlers/brain-handlers');

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
});

describe('SDD Brain decision chat attribution', () => {
  it('routes a tab-3 run decision to tab 3 while tab 1 stays foreground', async () => {
    for (const id of ['tab-1', 'tab-2', 'tab-3', 'tab-4']) ensureLane(id);
    useSessionTabStore.getState().openTab('tab-1');

    const events = new EventBus();
    const runtime = { session: { id: 'tab-1' } };
    const { sessionPayload } = createSetupEventSessionHelpers(runtime as never, undefined);
    const delivered: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const socket = (deliver = false) => ({
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((raw: string) => {
        const msg = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        if (deliver && msg.type === 'brain.event') {
          delivered.push(msg);
          handleBrainEvent(msg as never);
        }
      }),
    });
    const page = socket(true);
    const foregroundOnly = socket();
    const backgroundOnly = socket();
    const clients = new Map([
      [
        page as never,
        { ws: page, sessionId: 'tab-1', sessionIds: new Set(['tab-1', 'tab-2', 'tab-3', 'tab-4']) },
      ],
      [
        foregroundOnly as never,
        { ws: foregroundOnly, sessionId: 'tab-1', sessionIds: new Set(['tab-1']) },
      ],
      [
        backgroundOnly as never,
        { ws: backgroundOnly, sessionId: 'tab-3', sessionIds: new Set(['tab-3']) },
      ],
    ]) as never;
    const disposers = registerSetupEventsPatternHandlers({
      events,
      broadcast,
      clients,
      sessionPayload,
    });
    const brain = new ObservableBrainArbiter(
      { decide: async () => ({ type: 'answer', optionId: 'retry', text: 'Retry from tab 3' }) },
      events,
    );
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () => ({ loadExisting: async () => false }) as never,
      runInterviewTurn: async () => '',
      startRun: async () => ({ runId: 'unused' }),
      startRunFromGraphId: async (_graphId, opts) => {
        const supervisor = new SddSupervisor({ brain, sessionId: opts.sessionId });
        await supervisor.superviseFailure({
          task: { id: 'task-3', title: 'Failed task' } as never,
          error: 'failed',
          attempts: 1,
        });
        return { runId: 'run-3' };
      },
    });

    try {
      await handler.handleMessage({
        type: 'sdd.run.from_graph',
        payload: { graphId: 'graph-3', sessionId: 'tab-3' },
      });

      expect(delivered.map((msg) => [msg.payload.event, msg.payload.sessionId])).toEqual([
        ['brain.decision_requested', 'tab-3'],
        ['brain.decision_answered', 'tab-3'],
      ]);
      expect(readLane('tab-3').messages.map((msg) => msg.content)).toEqual([
        expect.stringContaining('Retry from tab 3'),
      ]);
      for (const id of ['tab-1', 'tab-2', 'tab-4']) {
        expect(readLane(id).messages).toEqual([]);
      }
      expect(backgroundOnly.send).toHaveBeenCalledTimes(2);
      expect(foregroundOnly.send).not.toHaveBeenCalled();
      expect(useChatLanes.getState().activeSessionId).toBe('tab-1');
    } finally {
      handler.dispose();
      for (const dispose of disposers) dispose();
    }
  });
});
