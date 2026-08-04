/**
 * Focused coverage for services/dispatch-classifier.ts — the LLM-backed
 * provider classifier wrapper used by /fleet dispatch. Exercises the
 * array-content path, the empty-content fallback, and the provider-throw
 * catch.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeProviderClassifier } from '../src/services/dispatch-classifier.js';
import type { CommitLLMProvider } from '../src/services/commit-message.js';

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
        maxTokens: 120,
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
