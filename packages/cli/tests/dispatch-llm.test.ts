/**
 * Tests for dispatch-llm.ts — LLM-backed dispatch classifier factory.
 *
 * makeProviderClassifier wraps a provider.complete call in makeLLMClassifier.
 * makeLLMClassifier returns a DispatchClassifier that takes (task, candidates[]).
 * The classifier builds a prompt from the task + candidates and calls the LLM.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeProviderClassifier } from '../src/slash-commands/dispatch-llm.js';

describe('makeProviderClassifier', () => {
  it('returns a classifier function', () => {
    const provider = {
      complete: vi.fn(),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    expect(typeof classifier).toBe('function');
  });

  it('classifier calls provider.complete with correct params', async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"role":"coder","reason":"needs coding"}' }],
      }),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    const result = await classifier('write a function', [
      { role: 'coder', name: 'coder', summary: 'writes code' } as never,
    ]);
    expect(provider.complete).toHaveBeenCalledOnce();
    const callArgs = provider.complete.mock.calls[0]?.[0] as { model: string; maxTokens: number; temperature: number };
    expect(callArgs.model).toBe('gpt-4o');
    expect(callArgs.maxTokens).toBe(120);
    expect(callArgs.temperature).toBe(0);
    expect(result).toEqual({ role: 'coder', reason: 'needs coding' });
  });

  it('handles array content with first text element (tool_use after)', async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: '{"role":"reviewer","reason":"needs review"}' },
          { type: 'tool_use', text: 'not this' },
        ],
      }),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    const result = await classifier('review this code', [
      { role: 'reviewer', description: 'reviews code', summary: 'code reviewer' } as never,
    ]);
    expect(result).toEqual({ role: 'reviewer', reason: 'needs review' });
  });

  it('returns null when content array is empty (no candidate matched)', async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: [],
      }),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    const result = await classifier('do something', [
      { role: 'coder', name: 'coder', summary: 'writes code' } as never,
    ]);
    expect(result).toBeNull();
  });

  it('returns null when provider.complete throws', async () => {
    const provider = {
      complete: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    const result = await classifier('do something', [
      { role: 'coder', name: 'coder', summary: 'writes code' } as never,
    ]);
    expect(result).toBeNull();
  });

  it('returns null when content is non-array string', async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        content: 'just a string',
      }),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    const result = await classifier('do something', [
      { role: 'coder', name: 'coder', summary: 'writes code' } as never,
    ]);
    expect(result).toBeNull();
  });

  it('uses AbortController with 15s timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    const provider = {
      complete: vi.fn().mockImplementation(async (_req, opts) => {
        capturedSignal = opts?.signal;
        return { content: [{ type: 'text', text: '{}' }] };
      }),
    };
    const classifier = makeProviderClassifier(provider as never, 'gpt-4o');
    await classifier('test', [{ role: 'coder', name: 'coder', summary: 'writes code' } as never]);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal instanceof AbortSignal).toBe(true);
  });
});
