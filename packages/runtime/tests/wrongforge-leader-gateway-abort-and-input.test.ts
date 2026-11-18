import { EventBus } from '@wrongstack/contracts/kernel';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import {
  type LeaderGateway,
  startLeaderGateway,
} from '../src/wrongforge-leader/wrongforge-leader-gateway.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('startLeaderGateway confirmation abort fencing and body/input validation', () => {
  const gateways: LeaderGateway[] = [];

  afterEach(async () => {
    for (const gw of gateways.splice(0)) {
      await gw.close();
    }
  });

  const editTool = {
    name: 'edit',
    description: 'edit file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  } as unknown as Tool;

  it('rejects non-object bodies and non-object input fields with 400 while allowing empty or valid object payloads', async () => {
    const executed: Array<Record<string, unknown>> = [];
    const host = {
      events: new EventBus(),
      listTools: () => [editTool],
      permission: () => undefined,
      context: () => undefined,
      runTool: async (_name: string, input: Record<string, unknown>) => {
        executed.push(input);
        return { content: 'ok', isError: false };
      },
    } as unknown as AcpLeaderHost;

    const gw = await startLeaderGateway(host, 'sess-val');
    expect(gw).toBeDefined();
    gateways.push(gw!);
    const auth = {
      authorization: `Bearer ${gw!.spec.token}`,
      'content-type': 'application/json',
    };

    const okEmpty = await fetch(`${gw!.spec.url}/v1/tools/edit/call`, {
      method: 'POST',
      headers: auth,
      body: '',
    });
    expect(okEmpty.status).toBe(200);
    expect(executed).toEqual([{}]);

    for (const badBody of [
      '123',
      'true',
      '[1,2]',
      JSON.stringify({ input: null }),
      JSON.stringify({ input: 'not-an-object' }),
      JSON.stringify({ input: [1] }),
    ]) {
      const res = await fetch(`${gw!.spec.url}/v1/tools/edit/call`, {
        method: 'POST',
        headers: auth,
        body: badBody,
      });
      expect(res.status).toBe(400);
    }
    expect(executed).toHaveLength(1);
  });

  it('aborts pending confirmThroughEvents on HTTP disconnect or gateway.close() and blocks late execution', async () => {
    const events = new EventBus();
    const confirmNeeded = deferred<{ resolve: (decision: 'yes' | 'no') => void }>();
    const confirmResolved = deferred<{ source: string }>();
    const executed: Array<Record<string, unknown>> = [];

    events.on('tool.confirm_needed', (ev) => {
      confirmNeeded.resolve(ev as unknown as { resolve: (decision: 'yes' | 'no') => void });
    });
    events.on('tool.confirm_resolved', (ev) => {
      confirmResolved.resolve(ev as unknown as { source: string });
    });

    const host = {
      events,
      confirmThroughEvents: true,
      listTools: () => [editTool],
      permission: () => undefined,
      context: () => undefined,
      runTool: async (
        _name: string,
        input: Record<string, unknown>,
        opts: { approve?: (tool: Tool, input: Record<string, unknown>) => Promise<boolean> },
      ) => {
        const ok = await opts.approve!(editTool, input);
        if (!ok) return { content: 'denied', isError: true };
        executed.push(input);
        return { content: 'edited', isError: false };
      },
    } as unknown as AcpLeaderHost;

    const gw = await startLeaderGateway(host, 'sess-abort');
    expect(gw).toBeDefined();
    gateways.push(gw!);

    const reqAbort = new AbortController();
    const callDone = fetch(`${gw!.spec.url}/v1/tools/edit/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw!.spec.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: { path: 'src/danger.ts' } }),
      signal: reqAbort.signal,
    }).catch(() => undefined);

    const prompt = await confirmNeeded.promise;
    reqAbort.abort();
    await callDone;
    await gw!.close();

    const resolved = await confirmResolved.promise;
    expect(resolved.source).toBe('abort');

    prompt.resolve('yes');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(executed).toHaveLength(0);
  });
});
