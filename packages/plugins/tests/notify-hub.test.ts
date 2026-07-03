import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyHubPlugin = (await import('../src/notify-hub')).default;

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
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onPattern: vi.fn(() => vi.fn()),
  };
}

function getTool(
  api: MockApi,
  name: string,
): { execute: (input: unknown) => Promise<Record<string, unknown>> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<Record<string, unknown>> };
}

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  globalThis.fetch = fetchMock as never;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const URL_CFG = { 'notify-hub': { webhookUrl: 'https://hooks.example.test/x' } };

describe('notify-hub plugin', () => {
  it('registers notify_send + notify_hub_status', () => {
    const api = makeApi();
    notifyHubPlugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toEqual(expect.arrayContaining(['notify_send', 'notify_hub_status']));
  });

  it('idles without webhookUrl: no hooks, no bus subscriptions, notify_send errors', async () => {
    const api = makeApi();
    notifyHubPlugin.setup(api as never);
    expect(api.registerHook).not.toHaveBeenCalled();
    expect(api.onPattern).not.toHaveBeenCalled();
    const result = await getTool(api, 'notify_send').execute({ message: 'hi' });
    expect(result['ok']).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a webhookUrl registers Stop hook + tool.error subscription (defaults)', () => {
    const api = makeApi({ extensions: URL_CFG });
    notifyHubPlugin.setup(api as never);
    expect(api.registerHook).toHaveBeenCalledWith('Stop', undefined, expect.any(Function));
    expect(api.onPattern).toHaveBeenCalledWith('tool.*', expect.any(Function));
  });

  it('notify_send POSTs JSON to the webhook', async () => {
    const api = makeApi({ extensions: URL_CFG });
    notifyHubPlugin.setup(api as never);
    const result = await getTool(api, 'notify_send').execute({
      title: 'done',
      message: 'migration finished',
      level: 'info',
    });
    expect(result['ok']).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.test/x');
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body['event']).toBe('manual');
    expect(body['message']).toBe('migration finished');
  });

  it('sends custom headers', async () => {
    const api = makeApi({
      extensions: {
        'notify-hub': { webhookUrl: 'https://h.test/x', headers: { authorization: 'Bearer t' } },
      },
    });
    notifyHubPlugin.setup(api as never);
    await getTool(api, 'notify_send').execute({ message: 'x' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers['authorization']).toBe('Bearer t');
  });

  it('opens the circuit after maxConsecutiveFailures and suppresses further sends', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const api = makeApi({
      extensions: { 'notify-hub': { webhookUrl: 'https://h.test/x', maxConsecutiveFailures: 2 } },
    });
    notifyHubPlugin.setup(api as never);
    const send = getTool(api, 'notify_send');
    await send.execute({ message: '1' });
    await send.execute({ message: '2' }); // circuit opens
    await send.execute({ message: '3' }); // suppressed
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const status = await getTool(api, 'notify_hub_status').execute({});
    expect(status['circuitOpen']).toBe(true);
    const counters = status['counters'] as Record<string, number>;
    expect(counters['failed']).toBe(2);
    expect(counters['suppressed']).toBe(1);
    const health = (await notifyHubPlugin.health!()) as { ok: boolean };
    expect(health.ok).toBe(false);
  });

  it('non-2xx responses count as failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const api = makeApi({ extensions: URL_CFG });
    notifyHubPlugin.setup(api as never);
    const result = await getTool(api, 'notify_send').execute({ message: 'x' });
    expect(result['ok']).toBe(false);
  });

  it('enabled:false idles even with a webhookUrl', async () => {
    const api = makeApi({
      extensions: { 'notify-hub': { enabled: false, webhookUrl: 'https://h.test/x' } },
    });
    notifyHubPlugin.setup(api as never);
    expect(api.registerHook).not.toHaveBeenCalled();
    const result = await getTool(api, 'notify_send').execute({ message: 'x' });
    expect(result['ok']).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Stop hook delivers a session.stop event', async () => {
    const api = makeApi({ extensions: URL_CFG });
    notifyHubPlugin.setup(api as never);
    const stopHook = api.registerHook.mock.calls[0]![2] as (input: unknown) => void;
    stopHook({ sessionId: 's1', cwd: '/w' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body['event']).toBe('session.stop');
    expect(body['sessionId']).toBe('s1');
  });

  it('teardown resets state and logs', async () => {
    const api = makeApi({ extensions: URL_CFG });
    notifyHubPlugin.setup(api as never);
    notifyHubPlugin.teardown!(api as never);
    const health = (await notifyHubPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['sent']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('notify-hub: teardown complete', expect.any(Object));
  });
});
