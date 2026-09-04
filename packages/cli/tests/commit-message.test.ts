/**
 * Focused coverage for services/commit-message.ts — the shared LLM-powered
 * commit message generator. Tests the happy path (content array), the
 * single-text-object path, the too-short/long guard, and the heuristic
 * fallback when the provider throws or the diff is empty.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CommitLLMProvider,
  generateCommitMessageWithLLM,
} from '../src/services/commit-message.js';

afterEach(() => {
  vi.useRealTimers();
});

function providerWith(content: unknown): CommitLLMProvider {
  return {
    complete: vi.fn(async () => ({
      content: content as never,
      model: 'test-model',
    })),
  };
}

const SAMPLE_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;';

describe('generateCommitMessageWithLLM', () => {
  it('uses the first line of an array content block', async () => {
    const provider = providerWith([{ type: 'text', text: 'feat(a): add x\n\nMore detail' }]);
    const message = await generateCommitMessageWithLLM(SAMPLE_DIFF, {
      provider,
      model: 'test-model',
    });
    expect(message).toBe('feat(a): add x');
    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model', maxTokens: 80 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('handles a single text-object content payload', async () => {
    const provider = providerWith({ type: 'text', text: 'fix: resolve crash' });
    const message = await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
    expect(message).toBe('fix: resolve crash');
  });

  it('falls back to empty string for text-less content shapes', async () => {
    // Array element without a text field → '' → heuristic fallback (line 59).
    const arrayNoText = providerWith([{ type: 'image' }]);
    expect(
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider: arrayNoText, model: 'm' }),
    ).toBe('chore: update');
    // Object without a text field → '' → heuristic fallback (line 61).
    const objectNoText = providerWith({ type: 'image' });
    expect(
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider: objectNoText, model: 'm' }),
    ).toBe('chore: update');
  });

  it('returns the raw string when content is not an array or object', async () => {
    const provider = providerWith('chore: raw string fallback');
    const message = await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
    expect(message).toBe('chore: raw string fallback');
  });

  it('falls back to heuristics when the provider throws', async () => {
    const provider: CommitLLMProvider = {
      complete: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const message = await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
    expect(message).toBe('chore: update');
  });

  it('falls back when the message is empty or over 200 chars', async () => {
    const emptyProvider = providerWith([{ type: 'text', text: '   ' }]);
    expect(
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider: emptyProvider, model: 'm' }),
    ).toBe('chore: update');

    const longProvider = providerWith([{ type: 'text', text: 'x'.repeat(201) }]);
    expect(
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider: longProvider, model: 'm' }),
    ).toBe('chore: update');
  });

  describe('abort-timer lifecycle (regression: timer leak on the error path)', () => {
    it('clears the 15s abort timer when the provider rejects', async () => {
      vi.useFakeTimers();
      const before = vi.getTimerCount();
      const provider: CommitLLMProvider = {
        complete: vi.fn(async () => {
          throw new Error('provider down');
        }),
      };
      const message = await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
      expect(message).toBe('chore: update');
      expect(vi.getTimerCount() - before).toBe(0);
    });

    it('clears the timer on the guard-fallthrough path (over-200-char message)', async () => {
      vi.useFakeTimers();
      const before = vi.getTimerCount();
      const provider = providerWith([{ type: 'text', text: 'x'.repeat(201) }]);
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
      expect(vi.getTimerCount() - before).toBe(0);
    });

    it('clears the timer on the success path', async () => {
      vi.useFakeTimers();
      const before = vi.getTimerCount();
      const provider = providerWith([{ type: 'text', text: 'feat(a): add x' }]);
      await generateCommitMessageWithLLM(SAMPLE_DIFF, { provider, model: 'm' });
      expect(vi.getTimerCount() - before).toBe(0);
    });
  });
});
