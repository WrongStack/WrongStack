import type { Config, ConfigStore } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleJevRoute } from '../src/server/jev-routes.js';

describe('Jev routes', () => {
  it('never starts billed diagnostics with a disabled master, even with a saved key', async () => {
    const send = vi.fn();
    const check = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const store = {
        get: () => ({ typesafe: { enabled: false, apiKey: 'private-key' } }) as Config,
      } as ConfigStore;
      const ctx = { store, file: '', vault: undefined, send, check };
      await handleJevRoute(ctx, {} as WebSocket, {
        type: 'jev.check',
        payload: { requestId: 'check' },
      });
      await handleJevRoute(ctx, {} as WebSocket, {
        type: 'jev.test',
        payload: { requestId: 'test' },
      });
      expect(check).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(send.mock.calls.at(-1)?.[1].payload.settings).toMatchObject({
        status: 'disabled',
        enabled: false,
      });
      expect(JSON.stringify(send.mock.calls)).not.toContain('private-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('shares an in-flight diagnostic run and hides stale reports after account changes', async () => {
    const send = vi.fn();
    let config = { typesafe: { enabled: true, apiKey: 'first' } } as Config;
    const store = { get: () => config } as ConfigStore;
    let finish!: (value: import('@wrongstack/runtime/jev-checks').JevCheckReport) => void;
    const check = vi.fn(
      () =>
        new Promise<import('@wrongstack/runtime/jev-checks').JevCheckReport>((resolve) => {
          finish = resolve;
        }),
    );
    const ctx = { store, file: '', vault: undefined, send, check };
    const first = handleJevRoute(ctx, {} as WebSocket, {
      type: 'jev.check',
      payload: { requestId: 'one' },
    });
    const second = handleJevRoute(ctx, {} as WebSocket, {
      type: 'jev.check',
      payload: { requestId: 'two' },
    });
    await handleJevRoute(ctx, {} as WebSocket, { type: 'jev.get' });
    expect(send.mock.calls.at(-1)?.[1].payload.checks.running).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    finish({ at: 1, model: 'jev', route: 'typesafe', cases: [], passed: 20, total: 20 });
    await Promise.all([first, second]);
    expect(send.mock.calls.at(-1)?.[1].payload.checks.report.passed).toBe(20);
    config = { typesafe: { enabled: true, apiKey: 'second' } } as Config;
    await handleJevRoute(ctx, {} as WebSocket, { type: 'jev.get' });
    expect(send.mock.calls.at(-1)?.[1].payload.checks.report).toBeUndefined();
    expect(JSON.stringify(send.mock.calls)).not.toContain('first');
  });
  it('returns a correlated credential-free account snapshot', async () => {
    const send = vi.fn();
    const store = {
      get: () =>
        ({ typesafe: { enabled: true, route: 'typesafe', apiKey: 'private-key' } }) as Config,
    } as ConfigStore;
    expect(
      await handleJevRoute({ store, file: '', vault: undefined, send }, {} as WebSocket, {
        type: 'jev.get',
        payload: { requestId: 'tab-1' },
      }),
    ).toBe(true);
    const response = send.mock.calls[0]?.[1];
    expect(response.payload).toMatchObject({
      requestId: 'tab-1',
      settings: { status: 'ready', keySource: 'config' },
      activity: { scope: 'process' },
    });
    expect(JSON.stringify(response)).not.toContain('private-key');
  });
  it('rejects an invalid patch without publishing a successful save or supplied values', async () => {
    const send = vi.fn();
    const store = { get: () => ({}) as Config, update: vi.fn() } as unknown as ConfigStore;
    await handleJevRoute({ store, file: '', vault: undefined, send }, {} as WebSocket, {
      type: 'jev.set',
      payload: { requestId: 'bad', patch: { endpoint: 'https://secret:password@host/' } },
    });
    expect(store.update).not.toHaveBeenCalled();
    const response = send.mock.calls[0]?.[1];
    expect(response.payload.error).toBeTruthy();
    expect(JSON.stringify(response)).not.toContain('password');
  });
  it('reports an unavailable host instead of leaving the form waiting', async () => {
    const send = vi.fn();
    await handleJevRoute({ store: undefined, file: '', vault: undefined, send }, {} as WebSocket, {
      type: 'jev.get',
      payload: { requestId: 'request' },
    });
    expect(send.mock.calls[0]?.[1].payload).toMatchObject({
      requestId: 'request',
      error: expect.any(String),
    });
  });
});
