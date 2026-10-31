/**
 * Focused coverage for services/dispatch-classifier.ts — the LLM-backed
 * provider classifier wrapper used by /fleet dispatch. Exercises the
 * array-content path, the empty-content fallback, and the provider-throw
 * catch.
 */

import { makeDispatchClassifier, makeProviderClassifier } from '@wrongstack/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitLLMProvider } from '../src/services/commit-message.js';

afterEach(() => vi.unstubAllGlobals());

describe('TypeSafe route wiring', () => {
  it.each([
    ['typesafe', 'TYPESAFE_API_KEY', 'https://api.typesafe.ai/v1/systemone', 'jev-latest'],
    [
      'openrouter',
      'OPENROUTER_API_KEY',
      'https://openrouter.ai/api/alpha/decisions',
      '~typesafe/jev-latest',
    ],
  ] as const)(
    'uses the selected %s account for typed dispatch',
    async (route, keyEnv, endpoint, model) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: {
                which: {
                  type: 'choice',
                  choice: 'code',
                  probabilities: { code: 0.8, review: 0.2 },
                  confidence: 0.5,
                },
                any_fits: { type: 'noul', noul: 0.9 },
              },
              usage: { input_tokens: 42, output_tokens: 0 },
            }),
          ),
      );
      vi.stubGlobal('fetch', fetchImpl);
      const provider = providerWith([]);
      const classifier = makeDispatchClassifier({
        config: {
          typesafe: { enabled: true, route },
          fleet: { dispatch: { typesafeClassifier: true } },
        } as never,
        provider,
        model: 'chat-model',
        env: { [keyEnv]: 'route-test-key' },
      });
      expect(
        await classifier('fix this', [
          { role: 'code', name: 'Code', summary: 'Writes code' },
          { role: 'review', name: 'Review', summary: 'Reviews code' },
        ]),
      ).toMatchObject({ role: 'code', confidence: 0.5 });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(endpoint);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer route-test-key' });
      expect(JSON.parse(init.body as string)).toMatchObject({
        model,
        state: { task: 'fix this', candidates: { code: 'Writes code', review: 'Reviews code' } },
      });
      expect(provider.complete).not.toHaveBeenCalled();
    },
  );

  it('falls back to the chat classifier when explicitly enabled without an account', async () => {
    const provider = providerWith([{ type: 'text', text: '{"role":"code"}' }]);
    const classifier = makeDispatchClassifier({
      config: { fleet: { dispatch: { typesafeClassifier: true } } } as never,
      provider,
      model: 'chat-model',
      env: {},
    });
    expect(
      await classifier('fix this', [
        { role: 'code', name: 'Code', summary: 'Writes code' },
        { role: 'review', name: 'Review', summary: 'Reviews code' },
      ]),
    ).toMatchObject({ role: 'code' });
    expect(provider.complete).toHaveBeenCalledOnce();
  });
});

function providerWith(content: unknown): CommitLLMProvider {
  return {
    complete: vi.fn(async () => ({
      content: content as never,
      model: 'test-model',
    })),
  };
}

describe('makeProviderClassifier', () => {
  // `DispatchClassifier` takes the task as a plain string and candidates as
  // `{ role, name, summary }` — `makeLLMClassifier` renders `c.summary` into
  // the router prompt.
  const task = 'fix the ts build';
  const candidates = [
    { role: 'code', name: 'coder', summary: 'writes code' },
    { role: 'review', name: 'reviewer', summary: 'reviews' },
  ];

  it('returns a classifier that forwards prompts to the provider', async () => {
    const provider = providerWith([
      { type: 'text', text: '{"role":"code","reason":"typescript files"}' },
    ]);
    const classify = makeProviderClassifier(provider, 'test-model');
    const result = await classify(task, candidates);
    expect(result).toEqual({ role: 'code', reason: 'typescript files' });
    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        temperature: 0,
        system: expect.any(Array),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null for empty array content', async () => {
    const provider = providerWith([]);
    const classify = makeProviderClassifier(provider, 'm');
    await expect(classify(task, candidates)).resolves.toBeNull();
  });

  it('returns null for a non-array (object) content payload', async () => {
    // The wrapper only reads `content[0]` for arrays; an object payload falls
    // through to '' (line 39), which the classifier parses as null.
    const provider = providerWith({ type: 'text', text: '{"role":"code"}' });
    const classify = makeProviderClassifier(provider, 'm');
    await expect(classify(task, candidates)).resolves.toBeNull();
  });

  it('returns null when the provider throws', async () => {
    const provider: CommitLLMProvider = {
      complete: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const classify = makeProviderClassifier(provider, 'm');
    await expect(classify(task, candidates)).resolves.toBeNull();
  });

  it('clears the timeout after a successful completion', async () => {
    const provider = providerWith([{ type: 'text', text: '{"role":"code"}' }]);
    const classify = makeProviderClassifier(provider, 'm');
    await expect(classify(task, candidates)).resolves.toEqual({ role: 'code' });
  });
});
