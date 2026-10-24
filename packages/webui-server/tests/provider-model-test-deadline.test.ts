import type { Provider, Response } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ProviderModelTestResult,
  runProviderModelTests,
} from '../src/server/provider/model-test.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const response: Response = {
  model: 'model',
  content: [{ type: 'text', text: 'OK' }],
  stopReason: 'end_turn',
  usage: { input: 4, output: 1 },
};
const timeoutError = () => new DOMException('The operation timed out', 'TimeoutError');

function params(complete: Provider['complete'], signal: AbortSignal, modelIds = ['model']) {
  const results: ProviderModelTestResult[] = [];
  return {
    results,
    value: {
      requestId: 'run',
      providerId: 'provider',
      modelIds,
      timeoutMs: 1000,
      maxTokens: 32,
      provider: { complete } as unknown as Provider,
      signal,
      metadata: async () => ({}),
      onResult: (result: ProviderModelTestResult) => results.push(result),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('model-test deadline owns late responses', () => {
  it('reports a timeout when the deadline wins before the transport resolves', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const entered = deferred<void>();
    const reply = deferred<Response>();
    let offered: AbortSignal | undefined;
    const complete = vi.fn((_request: unknown, opts: { signal: AbortSignal }) => {
      offered = opts.signal;
      entered.resolve();
      return reply.promise;
    });
    const setup = params(complete, new AbortController().signal);
    const run = runProviderModelTests(setup.value);
    await entered.promise;
    deadline.abort(timeoutError());
    expect(offered?.aborted).toBe(true);
    reply.resolve(response);
    expect(await run).toEqual({ passed: 0, failed: 1, cancelled: 0 });
    expect(setup.results).toEqual([
      expect.objectContaining({ status: 'failed', diagnosis: 'timeout', errorKind: 'timeout' }),
    ]);
    expect(timeout).toHaveBeenCalledWith(1000);
  });

  it('uses a fresh deadline for the next model after the first model times out', async () => {
    const firstDeadline = new AbortController();
    const nextDeadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(firstDeadline.signal)
      .mockReturnValueOnce(nextDeadline.signal);
    const entered = deferred<void>();
    const reply = deferred<Response>();
    const complete = vi.fn((request: { model: string }) => {
      if (request.model === 'first') {
        entered.resolve();
        return reply.promise;
      }
      return Promise.resolve(response);
    });
    const setup = params(complete, new AbortController().signal, ['first', 'second']);
    const run = runProviderModelTests(setup.value);
    await entered.promise;
    firstDeadline.abort(timeoutError());
    reply.resolve(response);
    expect(await run).toEqual({ passed: 1, failed: 1, cancelled: 0 });
    expect(setup.results.map((result) => result.diagnosis)).toEqual(['timeout', 'ok']);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('keeps a caller stop classified as cancelled rather than timeout', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    const caller = new AbortController();
    const entered = deferred<void>();
    const reply = deferred<Response>();
    const setup = params(
      vi.fn(() => {
        entered.resolve();
        return reply.promise;
      }),
      caller.signal,
    );
    const run = runProviderModelTests(setup.value);
    await entered.promise;
    caller.abort();
    reply.resolve(response);
    expect(await run).toEqual({ passed: 0, failed: 0, cancelled: 1 });
    expect(setup.results[0]?.diagnosis).toBe('cancelled');
  });

  it('keeps a response before a live deadline successful', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    const setup = params(
      vi.fn(async () => response),
      new AbortController().signal,
    );
    expect(await runProviderModelTests(setup.value)).toEqual({
      passed: 1,
      failed: 0,
      cancelled: 0,
    });
    expect(setup.results[0]?.diagnosis).toBe('ok');
  });
});
