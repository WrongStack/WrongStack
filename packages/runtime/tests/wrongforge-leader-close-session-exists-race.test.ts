import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sessionExistsGate = deferred<unknown>();
const sessionExistsEntered = deferred<void>();
let gatewayStarts = 0;
let gatewayCloses = 0;
let tasksCreated = 0;

vi.mock('@wrongstack/fleet', async (orig) => {
  const actual = await orig<typeof import('@wrongstack/fleet')>();
  return {
    ...actual,
    resolveWrongForgeEndpoint: () => ({ url: 'http://127.0.0.1:1', apiKey: 'test-key' }),
    wrongForgeCall: () => async (method: string, path: string) => {
      if (path === '/v1/info') {
        return { version: '1.0.0', features: ['builtin_tools'], models: ['m1'] };
      }
      if (method === 'GET' && path.startsWith('/v1/sessions/')) {
        sessionExistsEntered.resolve();
        return sessionExistsGate.promise;
      }
      if (method === 'POST' && path === '/v1/tasks') {
        tasksCreated++;
        return {
          task: {
            id: 'task-1',
            status: 'completed',
            result: {
              text: 'ok',
              finish_reason: 'stop',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        };
      }
      return {};
    },
    followTask: async () => ({
      id: 'task-1',
      status: 'completed',
      result: { text: 'ok', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    parseWrongForgeInfo: (v: unknown) => v,
    writeWrongForgeInfoCache: () => {},
    reportWrongForgeQuota: async () => {},
  };
});

vi.mock('../src/acp-leader/acp-leader-host.js', async (orig) => {
  const actual = await orig<typeof import('../src/acp-leader/acp-leader-host.js')>();
  return {
    ...actual,
    acpLeaderHost: () => ({
      getConfig: () => ({}),
      context: () => undefined,
    }),
    trackAcpLeader: () => {},
  };
});

vi.mock('../src/acp-leader/acp-leader-provider.js', async (orig) => {
  const actual = await orig<typeof import('../src/acp-leader/acp-leader-provider.js')>();
  return {
    ...actual,
    isLeaderTurn: () => true,
  };
});

vi.mock('../src/wrongforge-leader/wrongforge-leader-gateway.js', () => ({
  startLeaderGateway: async () => {
    gatewayStarts++;
    let closed = false;
    return {
      spec: { url: 'http://127.0.0.1:9999', token: 'tok' },
      tools: [],
      close: async () => {
        if (closed) return;
        closed = true;
        gatewayCloses++;
      },
    };
  },
}));

const { WrongForgeLeaderProvider } = await import(
  '../src/wrongforge-leader/wrongforge-leader-provider.js'
);

describe('WrongForgeLeaderProvider closeAll() during wfSessionExists()', () => {
  it('aborts stream before emitting or starting a task when closeAll() runs during wfSessionExists()', async () => {
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as never,
      buildProvider: () => undefined,
    });
    const ac = new AbortController();
    const iter = provider
      .stream(
        {
          model: 'm1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          cache: { sessionId: 'sess-race' },
        } as never,
        { signal: ac.signal },
      )
      [Symbol.asyncIterator]();

    const nextPromise = iter.next();
    await sessionExistsEntered.promise;
    await provider.closeAll();
    sessionExistsGate.resolve({ id: 'sess' });

    const events: unknown[] = [];
    let r = await nextPromise;
    while (!r.done) {
      events.push(r.value);
      r = await iter.next();
    }

    expect(events).toHaveLength(0);
    expect(tasksCreated).toBe(0);
    expect(gatewayStarts - gatewayCloses).toBe(0);
  });
});
