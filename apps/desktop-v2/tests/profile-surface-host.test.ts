import { describe, expect, it, vi } from 'vitest';
import type { EngineHttp } from '../src/engine-http';
import { EngineHttpError } from '../src/engine-http-error';
import type { BackendStream } from '../src/engine-stream';
import { prefList, prefProfiles, profileSurfaceHost } from '../src/profile-surface-host';

type Listener = (event: { type: string; payload: Record<string, unknown> }) => void;

function fakeStream() {
  const listeners = new Set<Listener>();
  const send = vi.fn(async () => undefined);
  const stream = {
    listen: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send,
    operations: { request: vi.fn(async () => ({})) },
  } as unknown as BackendStream;
  const emit = (type: string, payload: Record<string, unknown>) => {
    for (const listener of listeners) listener({ type, payload });
  };
  return { stream, send, emit, listeners };
}

describe('profile surface host', () => {
  it('delivers only the frames of the type a handler asked for, until it stops', () => {
    const { stream, emit, listeners } = fakeStream();
    const { client } = profileSurfaceHost(stream, vi.fn() as EngineHttp, async () => true);
    const seen: unknown[] = [];
    const stop = client.on('provider.quota', (message) => seen.push(message.payload));
    emit('providers.saved', { providers: [] });
    emit('provider.quota', { snapshots: [] });
    expect(seen).toEqual([{ snapshots: [] }]);
    stop();
    emit('provider.quota', { snapshots: [1] });
    expect(seen).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });

  it('sends requests on the profile connection', () => {
    const { stream, send } = fakeStream();
    const { client } = profileSurfaceHost(stream, vi.fn() as EngineHttp, async () => true);
    client.send({ type: 'provider.models', payload: { providerId: 'zai' } });
    client.send({ type: 'providers.saved' });
    expect(send).toHaveBeenNthCalledWith(1, 'provider.models', { providerId: 'zai' });
    expect(send).toHaveBeenNthCalledWith(2, 'providers.saved', {});
  });

  it("answers fetch with the engine's reply or its error status", async () => {
    const { stream } = fakeStream();
    const http = vi.fn(async (resource: string) => {
      if (resource === '/debug/system') return { pid: 1 };
      throw new EngineHttpError(503, { error: 'busy' });
    }) as unknown as EngineHttp;
    const { host } = profileSurfaceHost(stream, http, async () => true);
    const ok = await host.fetch('/debug/system');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pid: 1 });
    const failed = await host.fetch('/api/other');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'busy' });
  });
});

describe('model preference readers', () => {
  it('keeps only strings and named chains', () => {
    expect(prefList(['zai/glm', 3, null, 'openai/gpt'])).toEqual(['zai/glm', 'openai/gpt']);
    expect(prefList('zai/glm')).toEqual([]);
    expect(prefProfiles({ fast: ['zai/glm', 1], broken: 'x' })).toEqual({
      fast: ['zai/glm'],
      broken: [],
    });
    expect(prefProfiles(undefined)).toEqual({});
  });
});
