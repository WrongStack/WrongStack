import type { Provider, Response } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  diagnoseProviderModelTestFailure,
  runProviderModelTests,
} from '../src/server/provider/model-test.js';

describe('provider model test diagnostics', () => {
  it('distinguishes plan exhaustion, model availability, and output limits', () => {
    expect(diagnoseProviderModelTestFailure('quota_exhausted', 429, 'credits exhausted')).toBe(
      'quota_exhausted',
    );
    expect(diagnoseProviderModelTestFailure('invalid_request', 400, 'Model is unavailable')).toBe(
      'model_unavailable',
    );
    expect(
      diagnoseProviderModelTestFailure(
        'invalid_request',
        400,
        'max_output_tokens must be at least 16',
      ),
    ).toBe('token_limit');
  });
});

describe('provider model test runner', () => {
  it('tests models sequentially and continues after a classified failure', async () => {
    let active = 0;
    let maxActive = 0;
    const complete = vi.fn(async (request: { model: string }): Promise<Response> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      if (request.model === 'quota') {
        throw new ProviderError('Plan credits exhausted', 429, false, 'test', {
          kind: 'quota_exhausted',
        });
      }
      return {
        model: request.model,
        content: [{ type: 'text', text: 'OK' }],
        stopReason: 'end_turn',
        usage: { input: 4, output: 1 },
      };
    });
    const provider = {
      id: 'test',
      capabilities: {},
      complete,
      stream: vi.fn(),
    } as unknown as Provider;
    const results: Array<{ modelId: string; diagnosis: string }> = [];

    const summary = await runProviderModelTests({
      requestId: 'run-1',
      providerId: 'test-account',
      modelIds: ['good', 'quota', 'after'],
      provider,
      timeoutMs: 1_000,
      maxTokens: 32,
      signal: new AbortController().signal,
      metadata: async () => ({ maxContext: 100_000, maxOutput: 8_000 }),
      onResult: (result) => results.push(result),
    });

    expect(summary).toEqual({ passed: 2, failed: 1, cancelled: 0 });
    expect(maxActive).toBe(1);
    expect(results.map((result) => [result.modelId, result.diagnosis])).toEqual([
      ['good', 'ok'],
      ['quota', 'quota_exhausted'],
      ['after', 'ok'],
    ]);
  });
});
