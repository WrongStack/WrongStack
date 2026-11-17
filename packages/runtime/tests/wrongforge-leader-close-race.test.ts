import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let infoGate = deferred<{ version: string; features: string[]; models: Array<{ id: string }> }>();
let gatewayStarts = 0;
let gatewayCloses = 0;

vi.mock('@wrongstack/fleet', async (orig) => {
  const actual = await orig<typeof import('@wrongstack/fleet')>();
  return {
    ...actual,
    resolveWrongForgeEndpoint: () => ({ url: 'http://127.0.0.1:1', apiKey: 'test-key' }),
    wrongForgeCall: () => async (_method: string, path: string) => {
      if (path === '/v1/info') return infoGate.promise;
      return {};
    },
    parseWrongForgeInfo: (v: unknown) => v,
    writeWrongForgeInfoCache: () => {},
  };
});

vi.mock('../src/acp-leader/acp-leader-host.js', async (orig) => {
  const actual = await orig<typeof import('../src/acp-leader/acp-leader-host.js')>();
  return {
    ...actual,
    acpLeaderHost: () => ({}),
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
    return {
      url: 'http://127.0.0.1:9999',
      token: 'tok',
      close: async () => {
        gatewayCloses++;
      },
    };
  },
}));

const { WrongForgeLeaderProvider } = await import(
  '../src/wrongforge-leader/wrongforge-leader-provider.js'
);

afterEach(() => {
  infoGate = deferred();
  gatewayStarts = 0;
  gatewayCloses = 0;
});

describe('WrongForgeLeaderProvider closeAll() vs stream() race', () => {
  it('does not start an orphaned LeaderGateway after closeAll() runs while info() is in flight', async () => {
    const provider = new WrongForgeLeaderProvider({
      config: () => ({}) as never,
      buildProvider: () => undefined,
    });

    const ac = new AbortController();
    const iter = provider.stream(
      {
        model: 'claude-sonnet-5-5',
        messages: [],
        cache: { sessionId: 'sess-close-race' },
      } as never,
      { signal: ac.signal },
    );

    const nextPromise = iter.next().catch(() => ({ done: true, value: undefined }));
    await Promise.resolve();
    await Promise.resolve();

    await provider.closeAll();

    infoGate.resolve({ version: '1', features: [], models: [{ id: 'claude-sonnet-5-5' }] });
    await nextPromise;

    expect(gatewayStarts - gatewayCloses).toBe(0);
  });
});
