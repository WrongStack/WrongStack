import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentHandoffPlugin = (await import('../src/agent-handoff')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
  };
  onEvent: ReturnType<typeof vi.fn>;
  mailbox?: {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeApi(
  overrides: { extensions?: Record<string, unknown>; mailbox?: boolean } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    onEvent: vi.fn(() => vi.fn()),
    mailbox:
      overrides.mailbox !== false ? { send: vi.fn(async () => ({ id: 'msg-1' })) } : undefined,
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

function getEventHandler(api: MockApi, event: string): (payload: unknown) => void {
  const call = api.onEvent.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`event ${event} not subscribed`);
  return call[1] as (payload: unknown) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent-handoff plugin', () => {
  it('subscribes to subagent.done and registers two tools', async () => {
    const api = makeApi();
    agentHandoffPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    expect(api.onEvent).toHaveBeenCalledWith('subagent.done', expect.any(Function));
  });

  it('sends a handoff note on subagent.done', async () => {
    const api = makeApi();
    agentHandoffPlugin.setup(api as never);
    const handler = getEventHandler(api, 'subagent.done');
    handler({ agentName: 'worker-1', status: 'done', task: 'fix bug', result: { ok: true } });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.mailbox?.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'plugin:agent-handoff',
        to: 'leader',
        type: 'status',
      }),
    );
  });

  it('coerces object-valued fields instead of rendering [object Object]', async () => {
    // Regression: the `...raw` spread leaked unknown-typed values into the
    // string fields, so an object-valued task rendered into the note body as
    // "[object Object]" instead of readable JSON.
    const api = makeApi();
    agentHandoffPlugin.setup(api as never);
    const handler = getEventHandler(api, 'subagent.done');
    handler({
      task: { id: 't-1', title: 'fix bug' },
      status: 'done',
      result: { ok: true },
    });
    await new Promise((r) => setTimeout(r, 10));
    const send = api.mailbox?.send as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenCalledTimes(1);
    const note = send.mock.calls[0]?.[0] as { body?: string };
    expect(note.body).toContain('fix bug');
    expect(note.body).not.toContain('[object Object]');
  });

  it('handoff_note tool sends a manual note', async () => {
    const api = makeApi();
    agentHandoffPlugin.setup(api as never);
    const tool = getTool(api, 'handoff_note');
    const result = (await tool({ task: 'handover', summary: 'continue here' })) as {
      ok: boolean;
      messageId: string;
    };
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('msg-1');
  });

  it('enabled:false disables event handler and tool reports disabled', async () => {
    const api = makeApi({ extensions: { 'agent-handoff': { enabled: false } } });
    agentHandoffPlugin.setup(api as never);
    const tool = getTool(api, 'handoff_note');
    const result = (await tool({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    agentHandoffPlugin.setup(api as never);
    agentHandoffPlugin.teardown!(api as never);
    const health = (await agentHandoffPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['sent']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'agent-handoff: teardown complete',
      expect.any(Object),
    );
  });
});
