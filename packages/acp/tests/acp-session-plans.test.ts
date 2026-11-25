import { expect, it, vi } from 'vitest';
import { ACPSession } from '../src/client/acp-session.js';
import { FakeClientTransport } from './helpers/fake-client-transport.js';

it('negotiates and tracks independent plans outside the prompt lifecycle', async () => {
  const transport = new FakeClientTransport();
  const onPlansChanged = vi.fn();
  const entries = [{ content: 'Check the project', priority: 'high', status: 'pending' }];
  const notify = (update: object, sessionId = 'own') =>
    transport.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  transport.send.mockImplementation(async (rpc) => {
    if (rpc.method === 'initialize') {
      expect(rpc.params).toMatchObject({ clientCapabilities: { plan: {} } });
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: 1 } });
    } else if (rpc.method === 'session/new') {
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { sessionId: 'own' } });
      notify({ sessionUpdate: 'plan', entries });
    }
  });
  const session = await ACPSession.connect(transport, {
    command: 'fixture',
    projectRoot: '/p',
    timeoutMs: 500,
    onPlansChanged,
  });
  try {
    await session.openSession();
    const itemPlan = { type: 'items', planId: 'secondary', entries };
    const markdown = { type: 'markdown', planId: 'draft', content: '# Draft\n- Review results' };
    notify({ sessionUpdate: 'plan_update', plan: itemPlan });
    notify({
      sessionUpdate: 'plan_update',
      plan: { ...markdown, path: '/another/project/plan.md' },
    });
    notify({ sessionUpdate: 'plan_removed', planId: 'secondary' }, 'foreign');
    notify({ sessionUpdate: 'plan_removed', planId: 'unknown' });
    expect(session.getSessionPlans()).toEqual([
      { type: 'items', planId: null, entries },
      itemPlan,
      markdown,
    ]);
    expect(onPlansChanged).toHaveBeenCalledTimes(3);

    const changed = { ...itemPlan, type: 'markdown', content: '# Replacement' };
    notify({ sessionUpdate: 'plan_update', plan: changed });
    notify({ sessionUpdate: 'plan_removed', planId: 'draft' });
    notify({ sessionUpdate: 'plan', entries: [] });
    expect(session.getSessionPlans()).toEqual([
      { type: 'items', planId: null, entries: [] },
      { type: 'markdown', planId: 'secondary', content: '# Replacement' },
    ]);
    expect(onPlansChanged).toHaveBeenCalledTimes(6);
  } finally {
    await session.close();
  }
});
