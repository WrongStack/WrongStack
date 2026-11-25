import { expect, it, vi } from 'vitest';
import { ACPSession, textContent } from '../src/client/acp-session.js';
import type { PermissionPolicy } from '../src/client/permission.js';
import type { ACPMessage } from '../src/types/acp-messages.js';
import { FakeClientTransport } from './helpers/fake-client-transport.js';

it('keeps child updates and permissions scoped to the announced child', async () => {
  const transport = new FakeClientTransport();
  const rpcSent: ACPMessage[] = [];
  const policy = vi.fn<PermissionPolicy>(async () => ({ outcome: 'cancelled' }));
  const update = (sessionId: string, update: object) =>
    transport.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  transport.send.mockImplementation(async (rpc) => {
    rpcSent.push(rpc);
    if (rpc.method === 'initialize') {
      expect(rpc.params).toMatchObject({ clientCapabilities: { subagents: {} } });
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: 1 } });
    } else if (rpc.method === 'session/new') {
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { sessionId: 'root' } });
      update('root', { sessionUpdate: 'subagent_update', sessionId: 'child', title: 'Reviewer' });
      update('child', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Early report. ' },
      });
    } else if (rpc.method === 'session/prompt') {
      update('child', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Child report' },
      });
      update('root', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Root report' },
      });
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { stopReason: 'end_turn' } });
    }
  });
  const session = await ACPSession.connect(transport, {
    command: 'fixture',
    projectRoot: '/p',
    timeoutMs: 2_000,
    observeSubagents: true,
    permissionPolicy: policy,
  });
  try {
    await session.openSession();
    update('child', { sessionUpdate: 'subagent_update', sessionId: 'grandchild' });
    update('guest', { sessionUpdate: 'subagent_update', sessionId: 'unrelated' });
    update('grandchild', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      title: 'Wrong owner',
    });
    update('root', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      state: { state: 'running' },
    });
    const result = await session.prompt([textContent('Report')], AbortSignal.timeout(2_000));
    expect(result.text).toBe('Root report');
    expect(session.getChildSessions()).toMatchObject([
      {
        id: 'child',
        parentId: 'root',
        title: 'Reviewer',
        state: 'running',
        output: 'Early report. Child report',
      },
      { id: 'grandchild', parentId: 'child', state: 'unconfirmed' },
    ]);

    for (const [id, sessionId] of [
      [900, 'unknown'],
      [901, 'child'],
    ] as const) {
      transport.emit({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'same-id', kind: 'read' }, options: [] },
      });
    }
    await vi.waitFor(() => {
      expect(rpcSent).toContainEqual(
        expect.objectContaining({ id: 900, error: expect.anything() }),
      );
      expect(rpcSent).toContainEqual(
        expect.objectContaining({
          id: 901,
          result: { outcome: { outcome: 'cancelled' } },
        }),
      );
    });
    expect(policy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ child: { id: 'child', title: 'Reviewer' } }),
    );
    const childId = 'child' as Parameters<ACPSession['loadSession']>[0];
    await expect(session.loadSession(childId)).rejects.toThrow('owned by their parent');
    await expect(session.deleteSession(childId)).rejects.toThrow('owned by their parent');

    policy.mockImplementationOnce(() => new Promise(() => {}));
    transport.emit({
      jsonrpc: '2.0',
      id: 902,
      method: 'session/request_permission',
      params: {
        sessionId: 'child',
        toolCall: { toolCallId: 'pending', kind: 'read' },
        options: [],
      },
    });
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(2));
    update('root', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      state: { state: 'idle', stopReason: 'cancelled' },
    });
    await vi.waitFor(() =>
      expect(rpcSent).toContainEqual(
        expect.objectContaining({ id: 902, result: { outcome: { outcome: 'cancelled' } } }),
      ),
    );
    expect(policy.mock.calls[1]?.[0].signal.aborted).toBe(true);
    update('root', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      state: null,
      title: null,
    });
    expect(session.getChildSessions()[0]).toMatchObject({ title: null, state: 'unconfirmed' });
  } finally {
    await session.close();
  }
});

it('keeps replayed child labels without presenting historical activity as current', async () => {
  const transport = new FakeClientTransport();
  const update = (value: object) =>
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'root',
        update: { sessionUpdate: 'subagent_update', sessionId: 'child', ...value },
      },
    });
  transport.send.mockImplementation(async (rpc) => {
    if (rpc.method === 'initialize') {
      transport.emit({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    } else if (rpc.method === 'session/load') {
      update({ title: 'Recovered reviewer', state: { state: 'running' } });
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: {} });
    }
  });
  const session = await ACPSession.connect(transport, {
    command: 'fixture',
    projectRoot: '/p',
    timeoutMs: 2_000,
    observeSubagents: true,
  });
  try {
    await session.loadSession('root' as Parameters<ACPSession['loadSession']>[0]);
    expect(session.getChildSessions()).toMatchObject([
      { id: 'child', title: 'Recovered reviewer', state: 'unconfirmed' },
    ]);
    update({ state: { state: 'running' } });
    expect(session.getChildSessions()[0]?.state).toBe('running');
  } finally {
    await session.close();
  }
});
