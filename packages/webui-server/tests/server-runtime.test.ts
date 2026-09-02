import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket, WebSocketServer: vi.fn() };
});

vi.mock('../src/server/ws-auth.js', () => ({ verifyClient: vi.fn(() => true) }));
vi.mock('../src/server/port-utils.js', () => ({
  findFreePort: vi.fn(async (_host: string, port: number) => port),
  // server-runtime now routes the strict-port check through this helper;
  // default false keeps the mocked findFreePort path active as before.
  isStrictPort: vi.fn(() => false),
}));
vi.mock('../src/server/http-server.js', () => ({
  createHttpServer: vi.fn(() => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() })),
}));
vi.mock('../src/server/lifecycle.js', () => ({
  registerShutdownHandlers: vi.fn(() => () => undefined),
}));
vi.mock('../src/server/model-catalog.js', () => ({
  resolveProviderModelMetadata: vi.fn(async () => ({ capabilities: { maxContext: 128000 } })),
}));
vi.mock('../src/server/usage-cost.js', () => ({
  getCostRates: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0 })),
}));
vi.mock('../src/server/setup-events.js', () => ({
  setupEvents: vi.fn(() => () => undefined),
  FileWatcherMetrics: {},
}));

import { registerShutdownHandlers } from '../src/server/lifecycle.js';
import {
  resolvePorts,
  createSessionStartPayload,
  registerShutdown,
} from '../src/server/server-runtime.js';

describe('server-runtime', () => {
  it('returns the shutdown-listener disposer to its owner', () => {
    const unregister = vi.fn();
    vi.mocked(registerShutdownHandlers).mockReturnValueOnce(unregister);

    const result = registerShutdown({
      flushSession: vi.fn().mockResolvedValue(undefined),
      clients: () => new Map().values(),
      servers: [],
      onShutdown: vi.fn(),
    });

    expect(result).toBe(unregister);
  });

  describe('resolvePorts', () => {
    const oldEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...oldEnv };
      delete process.env['WEBUI_PORT'];
      delete process.env['PORT'];
      delete process.env['WEBUI_HOST'];
      delete process.env['WS_HOST'];
      delete process.env['WEBUI_PUBLIC_URL'];
      delete process.env['WEBUI_PUBLIC_WS_URL'];
      delete process.env['WEBUI_STRICT_PORT'];
      delete process.env['WEBUI_REQUIRE_TOKEN'];
    });

    it('defaults to 3456 for webui surface', async () => {
      const r = await resolvePorts({ surface: 'webui' });
      expect(r.httpPort).toBe(3456);
      expect(r.wsHost).toBe('127.0.0.1');
    });

    it('defaults to 3466 for simpleui surface', async () => {
      const r = await resolvePorts({ surface: 'simpleui' });
      expect(r.httpPort).toBe(3466);
    });

    it('uses explicit httpPort over env', async () => {
      process.env['WEBUI_PORT'] = '9999';
      const r = await resolvePorts({ surface: 'webui', httpPort: 4000 });
      expect(r.httpPort).toBe(4000);
    });

    it('uses WEBUI_HOST env when wsHost is absent', async () => {
      process.env['WEBUI_HOST'] = '0.0.0.0';
      const r = await resolvePorts({ surface: 'webui' });
      expect(r.wsHost).toBe('0.0.0.0');
    });

    it('reads publicUrl from opts or env', async () => {
      const r1 = await resolvePorts({ surface: 'webui', publicUrl: 'https://tunnel.example.com' });
      expect(r1.publicUrl).toBe('https://tunnel.example.com');
      process.env['WEBUI_PUBLIC_URL'] = 'https://env.example.com';
      const r2 = await resolvePorts({ surface: 'webui' });
      expect(r2.publicUrl).toBe('https://env.example.com');
    });

    it('respects WEBUI_STRICT_PORT to skip free-port search', async () => {
      process.env['WEBUI_STRICT_PORT'] = '1';
      const r = await resolvePorts({ surface: 'webui', httpPort: 7777 });
      expect(r.httpPort).toBe(7777);
    });

    it('detects requireToken from env', async () => {
      process.env['WEBUI_REQUIRE_TOKEN'] = '1';
      const r = await resolvePorts({ surface: 'webui' });
      expect(r.requireToken).toBe(true);
    });

    it('requireToken defaults to false', async () => {
      const r = await resolvePorts({ surface: 'webui' });
      expect(r.requireToken).toBe(false);
    });
  });

  describe('createSessionStartPayload', () => {
    it('builds a session.start payload with model metadata', async () => {
      const factory = createSessionStartPayload({
        getConfig: () =>
          ({
            provider: 'openai',
            model: 'gpt-4o',
            providers: {},
            context: {},
            features: {},
            brain: {},
            fallbackModels: [],
          }) as any,
        getSessionId: () => 'sess-1',
        getProjectRoot: () => '/tmp/myproject',
        getWorkingDir: () => '/tmp/myproject',
        getModeId: () => 'default',
        getContextMode: () => 'standard',
        getNeedsSetup: () => false,
        modelsRegistry: {
          getProvider: vi.fn(async () => ({
            models: [{ id: 'gpt-4o', limit: { context: 128000 } }],
          })),
        } as any,
      });
      const payload = await factory();
      expect(payload.sessionId).toBe('sess-1');
      expect(payload.model).toBe('gpt-4o');
      expect(payload.provider).toBe('openai');
      expect(payload.maxContext).toBeGreaterThan(0);
      expect(payload.projectName).toBe('myproject');
    });

    it('includes needsSetup when true', async () => {
      const factory = createSessionStartPayload({
        getConfig: () =>
          ({
            provider: 'openai',
            model: 'gpt-4o',
            providers: {},
            context: {},
            features: {},
            brain: {},
            fallbackModels: [],
          }) as any,
        getSessionId: () => 'sess-1',
        getProjectRoot: () => '/tmp/p',
        getWorkingDir: () => '/tmp/p',
        getModeId: () => 'default',
        getContextMode: () => 'standard',
        getNeedsSetup: () => true,
        modelsRegistry: { getProvider: vi.fn(async () => undefined) } as any,
      });
      const payload = await factory();
      expect(payload.needsSetup).toBe(true);
    });

    it('handles model metadata resolution failure gracefully', async () => {
      // The global mock for resolveProviderModelMetadata returns maxContext:128000.
      // This test verifies the factory does not throw when modelsRegistry.getProvider
      // rejects — the catch-all in the factory swallows the error and returns
      // whatever maxContext it could resolve (128000 from the mocked metadata).
      const factory = createSessionStartPayload({
        getConfig: () =>
          ({
            provider: 'bad',
            model: 'unknown',
            providers: {},
            context: {},
            features: {},
            brain: {},
            fallbackModels: [],
          }) as any,
        getSessionId: () => 'sess-1',
        getProjectRoot: () => '/tmp/p',
        getWorkingDir: () => '/tmp/p',
        getModeId: () => 'default',
        getContextMode: () => 'standard',
        getNeedsSetup: () => false,
        modelsRegistry: {
          getProvider: vi.fn(async () => {
            throw new Error('net');
          }),
        } as any,
      });
      const payload = await factory();
      // Must not throw, must still produce a valid payload
      expect(payload.sessionId).toBe('sess-1');
      expect(payload.model).toBe('unknown');
    });
  });
});
