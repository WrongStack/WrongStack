import { expect, it } from 'vitest';
import { ACPSession } from '../src/client/acp-session.js';
import type { SessionId } from '../src/types/acp-v1.js';
import { FakeClientTransport } from './helpers/fake-client-transport.js';

it('retains command announcements delivered with the session/new response', async () => {
  const transport = new FakeClientTransport();
  const advertised = {
    name: 'agent-status',
    description: 'Show status',
    input: { hint: 'verbose' },
  };
  transport.send.mockImplementation(async (rpc) => {
    const id = rpc.id;
    if (rpc.method === 'initialize') {
      transport.emit({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    }
    if (rpc.method === 'session/new') {
      transport.emit({ jsonrpc: '2.0', id, result: { sessionId: 'own' } });
      for (const sessionId of ['own', 'foreign']) {
        transport.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands:
                sessionId === 'own'
                  ? [
                      advertised,
                      { name: 'invalid name' },
                      { ...advertised, description: 'Duplicate' },
                    ]
                  : [{ name: 'foreign' }],
            },
          },
        });
      }
    }
    if (rpc.method === 'session/load') {
      transport.emit({ jsonrpc: '2.0', id, result: {} });
    }
  });
  const session = await ACPSession.connect(transport, {
    command: 'fixture',
    projectRoot: '/p',
    timeoutMs: 500,
  });
  try {
    await session.openSession();
    expect(session.getAvailableCommands()).toEqual([advertised]);
    await session.loadSession('other' as SessionId);
    expect(session.getAvailableCommands()).toEqual([]);
  } finally {
    await session.close();
  }
});
