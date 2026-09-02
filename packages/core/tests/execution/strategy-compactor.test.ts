import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';
import type { Message } from '../../src/types/messages.js';
import type { Provider } from '../../src/types/provider.js';

function fakeContext(messages: Message[], provider?: Provider): Context {
  const ctx = {
    messages,
    model: 'test-model',
    systemPrompt: '',
    tools: [],
    signal: new AbortController().signal,
    provider: provider ?? undefined,
    meta: {},
  } as never as Context;
  (ctx as never as { state: unknown }).state = {
    replaceMessages(next: Message[]) {
      messages.length = 0;
      messages.splice(0, 0, ...next);
    },
    appendMessage(m: Message) {
      messages.splice(messages.length, 0, m);
    },
  };
  return ctx;
}

function makeProvider(): Provider {
  return {
    id: 'test',
    capabilities: {
      tools: false,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: false,
      jsonMode: false,
      maxContext: 1000,
      cacheControl: 'none',
    },
    stream() {
      return (async function* () {})();
    },
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'llm summary' }],
      stopReason: 'end_turn',
      usage: { input: 100, output: 10 },
      model: 'test',
    }),
  };
}

function manyTurns(): Message[] {
  const out: Message[] = [];
  out.push({ role: 'user', content: 'IMPORTANT: keep this instruction' });
  out.push({ role: 'assistant', content: 'ok' });
  for (let i = 0; i < 20; i++) {
    out.push({ role: 'user', content: `q${i} ${'x'.repeat(80)}` });
    out.push({ role: 'assistant', content: `a${i} ${'y'.repeat(80)}` });
  }
  return out;
}

describe('createStrategyCompactor', () => {
  it('defaults to lossless hybrid that preserves earlier text and needs no provider', async () => {
    const messages = manyTurns();
    const ctx = fakeContext(messages); // no provider
    const compactor = createStrategyCompactor({ preserveK: 3 });
    const report = await compactor.compact(ctx, { aggressive: true });
    expect(report.collapsedDigest).toContain('IMPORTANT: keep this instruction');
    // No LLM available and none needed.
  });

  it('intelligent strategy uses the ctx provider for summarization', async () => {
    const provider = makeProvider();
    const messages = manyTurns();
    const ctx = fakeContext(messages, provider);
    const compactor = createStrategyCompactor({ strategy: 'intelligent', preserveK: 2 });
    const report = await compactor.compact(ctx, { aggressive: true });
    expect(provider.complete).toHaveBeenCalled();
    expect(report.reductions.some((r) => r.phase === 'summary')).toBe(true);
  });

  it('intelligent strategy degrades to lossless hybrid when ctx has no provider', async () => {
    const messages = manyTurns();
    const ctx = fakeContext(messages); // no provider
    const compactor = createStrategyCompactor({ strategy: 'intelligent', preserveK: 3 });
    // Must not throw; produces a lossless digest via the hybrid fallback.
    const report = await compactor.compact(ctx, { aggressive: true });
    expect(report.collapsedDigest).toContain('IMPORTANT: keep this instruction');
  });

  it('selective strategy runs against the ctx provider', async () => {
    const provider = makeProvider();
    const messages = manyTurns();
    const ctx = fakeContext(messages, provider);
    const compactor = createStrategyCompactor({ strategy: 'selective', preserveK: 2 });
    const report = await compactor.compact(ctx, { aggressive: true });
    expect(report).toBeDefined();
    expect(Array.isArray(report.reductions)).toBe(true);
  });

  it('llmSelector: true is a shortcut for the selective strategy (needs provider)', async () => {
    const provider = makeProvider();
    const messages = manyTurns();
    const ctx = fakeContext(messages, provider);
    const compactor = createStrategyCompactor({ llmSelector: true, preserveK: 2 });
    const report = await compactor.compact(ctx, { aggressive: true });
    // Selective path invokes the provider (selector and/or summarizer).
    expect(provider.complete).toHaveBeenCalled();
    expect(report).toBeDefined();
  });

  it('journals and flushes the exact post-compaction message state', async () => {
    const messages = manyTurns();
    messages[0]!._estTokens = 123;
    let revision = 0;
    const append = vi.fn().mockResolvedValue(undefined);
    const flush = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      messages,
      model: 'test-model',
      systemPrompt: [],
      tools: [],
      signal: new AbortController().signal,
      provider: undefined,
      meta: {},
      session: { id: 'journaled', append, flush },
      state: {
        get revision() {
          return revision;
        },
        replaceMessages(next: Message[]) {
          messages.length = 0;
          messages.push(...next);
          revision++;
        },
      },
    } as never as Context;

    const compactor = createStrategyCompactor({ preserveK: 3 });
    await compactor.compact(ctx, { aggressive: true });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_snapshot',
        reason: 'compaction',
        messages: expect.any(Array),
      }),
    );
    expect(JSON.stringify(append.mock.calls[0]?.[0])).not.toContain('_estTokens');
    expect(flush).toHaveBeenCalledOnce();
  });
});
