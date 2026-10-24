import type { Provider, Response } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProviderModelTestResult,
  runProviderModelTests,
} from '../src/server/provider/model-test.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const response: Response = {
  model: 'model',
  content: [{ type: 'text', text: 'OK' }],
  stopReason: 'end_turn',
  usage: { input: 4, output: 1 },
};

function params(complete: Provider['complete'], signal: AbortSignal, modelIds = ['model']) {
  const results: ProviderModelTestResult[] = [];
  return {
    results,
    value: {
      requestId: 'run',
      providerId: 'provider',
      modelIds,
      timeoutMs: 1_000_000,
      maxTokens: 32,
      provider: { complete } as unknown as Provider,
      signal,
      metadata: async () => ({}),
      onResult: (result: ProviderModelTestResult) => results.push(result),
    },
  };
}

describe('model-test cancellation owns late responses', () => {
  it.each(['resolve', 'reject'] as const)(
    'counts a response finishing with %s after cancellation as cancelled',
    async (completion) => {
      const entered = deferred<void>();
      const reply = deferred<Response>();
      const stop = new AbortController();
      const complete = vi.fn(() => {
        entered.resolve();
        return reply.promise;
      });
      const setup = params(complete, stop.signal);
      const run = runProviderModelTests(setup.value);
      await entered.promise;
      stop.abort();
      if (completion === 'resolve') reply.resolve(response);
      else reply.reject(new Error('transport rejected after cancellation'));
      expect(await run).toEqual({ passed: 0, failed: 0, cancelled: 1 });
      expect(setup.results).toEqual([
        expect.objectContaining({ status: 'cancelled', diagnosis: 'cancelled' }),
      ]);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it('does not send later model requests after cancelling the pending response', async () => {
    const entered = deferred<void>();
    const reply = deferred<Response>();
    const stop = new AbortController();
    const complete = vi.fn(() => {
      entered.resolve();
      return reply.promise;
    });
    const setup = params(complete, stop.signal, ['first', 'second', 'third']);
    const run = runProviderModelTests(setup.value);
    await entered.promise;
    stop.abort();
    reply.resolve(response);
    expect(await run).toEqual({ passed: 0, failed: 0, cancelled: 3 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(setup.results.map((result) => result.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('does not call a provider when cancellation occurs during metadata loading', async () => {
    const entered = deferred<void>();
    const metadata = deferred<Record<string, never>>();
    const stop = new AbortController();
    const complete = vi.fn(async () => response);
    const setup = params(complete, stop.signal);
    const run = runProviderModelTests({
      ...setup.value,
      metadata: () => {
        entered.resolve();
        return metadata.promise;
      },
    });
    await entered.promise;
    stop.abort();
    metadata.resolve({});
    expect(await run).toEqual({ passed: 0, failed: 0, cancelled: 1 });
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps an uncancelled successful response passed', async () => {
    const setup = params(
      vi.fn(async () => response),
      new AbortController().signal,
    );
    expect(await runProviderModelTests(setup.value)).toEqual({
      passed: 1,
      failed: 0,
      cancelled: 0,
    });
    expect(setup.results).toEqual([expect.objectContaining({ status: 'passed', diagnosis: 'ok' })]);
  });
});
