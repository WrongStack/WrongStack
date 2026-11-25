import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { AgentRosterWSHandler } from '../src/server/agent-roster-handlers.js';
import { handleAgentRosterRoute } from '../src/server/agent-roster-routes.js';
import type { WSClientMessage } from '../src/server/types.js';

describe('handleAgentRosterRoute (F2218)', () => {
  it('omits whitespace-only requestId from echoed responses', async () => {
    const sent: Array<{ payload?: Record<string, unknown> }> = [];
    const ws = {
      readyState: 1,
      send(data: string) {
        sent.push(JSON.parse(data) as { payload?: Record<string, unknown> });
      },
    } as unknown as WebSocket;

    await handleAgentRosterRoute(
      ws,
      { type: 'agent-roster.list', payload: { requestId: '   ' } } as unknown as WSClientMessage,
      {
        rosterHandler: {
          handleMessage: async () => ({ type: 'agent-roster.list', payload: { agents: [] } }),
        } as unknown as AgentRosterWSHandler,
      },
    );

    expect(sent[0]?.payload).toEqual({ agents: [] });
  });
});
