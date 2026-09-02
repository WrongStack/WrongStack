import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { findSafeBoundary } from '../../src/execution/compaction-core.js';
import { CompactionSummaryCache } from '../../src/execution/compaction-summary-cache.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
import type { Logger } from '../../src/types/logger.js';
import type { Message } from '../../src/types/messages.js';
import type { Provider } from '../../src/types/provider.js';

function fakeContext(messages: Message[]): Context {
  const ctx = {
    messages,
    model: 'test-model',
    signal: new AbortController().signal,
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

function makeFakeProvider(responses: string[]): Provider & { completeCalls: () => number } {
  let idx = 0;
  let calls = 0;
  return {
    completeCalls: () => calls,
    id: 'test',
    capabilities: {
      tools: false,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: false,
      jsonMode: false,
      maxContext: 128000,
      cacheControl: 'none',
    },
    stream() {
      return (async function* () {})();
    },
    async complete(_req) {
      calls++;
      const text = responses[idx++] ?? 'summary placeholder';
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { input: 100, output: 10 },
        model: 'test',
      };
    },
  };
}

describe('IntelligentCompactor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('elides large old tool results via elision phase', async () => {
    const big = 'x'.repeat(4_000);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] });
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `r${i}`, name: 'read', input: {} }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: big }],
      });
    }
    const ctx = fakeContext(messages);
    const provider = makeFakeProvider([]);
    const c = new IntelligentCompactor({
      provider,
      preserveK: 3,
      eliseThreshold: 1000,
      summaryCache: new CompactionSummaryCache(),
    });
    const report = await c.compact(ctx);

    expect(report.reductions.some((r) => r.phase === 'elision')).toBe(true);
    expect(report.after).toBeLessThan(report.before);
  });

  it('calls provider for summarization in aggressive mode', async () => {
    const messages: Message[] = [];
    // Use long enough content to push context over maxContext threshold
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: 'user',
        content: `This is a longer user query number ${i} with some extra text to increase token count`,
      });
      messages.push({
        role: 'assistant',
        content:
          'Here is a detailed response that helps answer the user question with relevant information',
      });
    }
    const ctx = fakeContext(messages);
    // Use a tiny maxContext so even modest content triggers summarization
    const provider = makeFakeProvider(['combined summary of ancient turns']);
    // preserveK=2 keeps only 4 recent messages, pushing cutoff deep into the list
    const c = new IntelligentCompactor({
      provider,
      preserveK: 2,
      maxContext: 10,
      summaryCache: new CompactionSummaryCache(),
    });

    const report = await c.compact(ctx, { aggressive: true });

    // Provider should have been called for summarization in aggressive mode.
    // The summary now also includes buildSmartDigest enrichment for critical content.
    expect(report.reductions.some((r) => r.phase === 'summary')).toBe(true);
  });

  it('reuses cached summaries for identical ancient context', async () => {
    const base: Message[] = [];
    for (let i = 0; i < 20; i++) {
      base.push({ role: 'user', content: `q${i}` });
      base.push({ role: 'assistant', content: 'ok' });
    }
    const preserveK = 3;
    const cutoff = base.length - preserveK * 2;
    expect(findSafeBoundary(base, 0, cutoff)).toBe(34);

    const provider = makeFakeProvider(['cached summary', 'unexpected second summary']);
    const summaryCache = new CompactionSummaryCache();
    // Each context needs its own array because fakeContext replaces messages in place.
    // Transient token estimates differ to verify they do not alter the cache-key contract.
    const first = fakeContext(base.map((message) => ({ ...message, _estTokens: 10 })));
    const second = fakeContext(base.map((message) => ({ ...message, _estTokens: 999 })));
    const firstCompactor = new IntelligentCompactor({ provider, preserveK, summaryCache });
    const secondCompactor = new IntelligentCompactor({ provider, preserveK, summaryCache });

    await firstCompactor.compact(first, { aggressive: true });
    await secondCompactor.compact(second, { aggressive: true });

    expect(first.messages[0]?.content).toContain('cached summary');
    expect(second.messages[0]?.content).toContain('cached summary');
    expect(provider.completeCalls()).toBe(1);

    const singleProvider = makeFakeProvider(['single-instance summary', 'unexpected repeat']);
    const singleCompactor = new IntelligentCompactor({
      provider: singleProvider,
      preserveK: 3,
      summaryCache: new CompactionSummaryCache(),
    });
    const third = fakeContext([...base]);
    const fourth = fakeContext([...base]);

    await singleCompactor.compact(third, { aggressive: true });
    await singleCompactor.compact(fourth, { aggressive: true });

    expect(third.messages[0]?.content).toContain('single-instance summary');
    expect(fourth.messages[0]?.content).toContain('single-instance summary');
    expect(fourth.messages[0]?.content).not.toContain('unexpected repeat');
    expect(singleProvider.completeCalls()).toBe(1);
  });

  it('composes caller cancellation with a summarizer timeout', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const callerSignal = new AbortController().signal;
    const ctx = fakeContext(messages);
    (ctx as { signal: AbortSignal }).signal = callerSignal;
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const anySpy = vi.spyOn(AbortSignal, 'any');
    let receivedSignal: AbortSignal | undefined;
    const provider = makeFakeProvider(['summary']);
    const complete = provider.complete.bind(provider);
    provider.complete = async (request, options) => {
      receivedSignal = options?.signal;
      return complete(request, options);
    };
    const compactor = new IntelligentCompactor({
      provider,
      preserveK: 3,
      summaryCache: new CompactionSummaryCache(),
    });

    await compactor.compact(ctx, { aggressive: true });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(anySpy).toHaveBeenCalledWith([callerSignal, timeoutSignal]);
    expect(receivedSignal).not.toBe(callerSignal);
    expect(receivedSignal).not.toBe(timeoutSignal);
  });

  it('shares semantic cache entries across direct and OneShot transports', async () => {
    const base: Message[] = [];
    for (let i = 0; i < 20; i++) {
      base.push({ role: 'user', content: `q${i}` });
      base.push({ role: 'assistant', content: 'ok' });
    }
    const summaryCache = new CompactionSummaryCache();
    const provider = makeFakeProvider(['shared transport summary']);
    const direct = new IntelligentCompactor({ provider, preserveK: 3, summaryCache });
    const call = vi.fn(async () => ({
      text: 'unexpected OneShot summary',
      model: 'test-model',
      provider: 'test',
      tokens: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      fromFallback: false,
    }));
    const orchestrated = new IntelligentCompactor({
      provider,
      preserveK: 3,
      summarizerModel: 'test-model',
      oneShotOrchestrator: { call } as never,
      summaryCache,
    });

    await direct.compact(fakeContext([...base]), { aggressive: true });
    const second = fakeContext([...base]);
    await orchestrated.compact(second, { aggressive: true });

    expect(call).not.toHaveBeenCalled();
    expect(second.messages[0]?.content).toContain('shared transport summary');
  });

  it('uses a lossless digest and retries when the provider returns empty text', async () => {
    const base: Message[] = [];
    for (let i = 0; i < 20; i++) {
      base.push({ role: 'user', content: `q${i}` });
      base.push({ role: 'assistant', content: 'ok' });
    }
    const provider = makeFakeProvider(['', '']);
    const summaryCache = new CompactionSummaryCache();
    const cacheSet = vi.spyOn(summaryCache, 'set');
    const firstCompactor = new IntelligentCompactor({ provider, preserveK: 3, summaryCache });
    const secondCompactor = new IntelligentCompactor({ provider, preserveK: 3, summaryCache });
    const first = fakeContext([...base]);
    const second = fakeContext([...base]);

    await firstCompactor.compact(first, { aggressive: true });
    // isPlaceholderSummary throws inside the compactor's getOrCreate callback,
    // so no cache entry is written and an identical later request can retry.
    expect(cacheSet).not.toHaveBeenCalled();
    await secondCompactor.compact(second, { aggressive: true });

    expect(first.messages[0]?.content).toContain('[user]: q0');
    expect(first.messages[0]?.content).not.toContain('(empty summary)');
    expect(second.messages[0]?.content).toContain('[user]: q0');
    expect(provider.completeCalls()).toBe(2);
  });

  it('keys cache entries from the bounded text sent to the summarizer', async () => {
    const makeMessages = (suffix: string): Message[] => {
      const messages: Message[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `${'x'.repeat(500)}${suffix}${i}` });
        messages.push({ role: 'assistant', content: 'ok' });
      }
      return messages;
    };
    const provider = makeFakeProvider(['bounded summary', 'unexpected second summary']);
    const summaryCache = new CompactionSummaryCache();
    const firstCompactor = new IntelligentCompactor({ provider, preserveK: 3, summaryCache });
    const secondCompactor = new IntelligentCompactor({ provider, preserveK: 3, summaryCache });

    await firstCompactor.compact(fakeContext(makeMessages('first-tail')), { aggressive: true });
    await secondCompactor.compact(fakeContext(makeMessages('second-tail')), { aggressive: true });

    expect(provider.completeCalls()).toBe(1);
  });

  it('uses summarizer response as the summary text', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const provider = makeFakeProvider(['custom summary']);
    const c = new IntelligentCompactor({
      provider,
      preserveK: 3,
      summaryCache: new CompactionSummaryCache(),
    });

    await c.compact(ctx, { aggressive: true });

    // The summary message should contain our custom text
    const summaryMsg = ctx.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('custom summary'),
    );
    expect(summaryMsg).toBeDefined();
  });

  it('falls back to a lossless digest and logs provider errors', async () => {
    const badProvider: Provider = {
      id: 'bad',
      capabilities: {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: false,
        jsonMode: false,
        maxContext: 128000,
        cacheControl: 'none',
      },
      stream() {
        return (async function* () {})();
      },
      async complete() {
        throw new Error('provider failed');
      },
    };

    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const logger = {
      level: 'debug',
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;
    const c = new IntelligentCompactor({
      provider: badProvider,
      preserveK: 3,
      summaryCache: new CompactionSummaryCache(),
      logger,
    });

    const report = await c.compact(ctx, { aggressive: true });

    // Should still produce a report without crashing
    expect(report).toBeDefined();
    expect(report.reductions).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith('Summarizer failed; falling back to lossless digest', {
      err: expect.objectContaining({ message: 'provider failed' }),
    });
  });

  it('does not summarize when not enough ancient messages', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'recent 1' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'recent 2' },
      { role: 'assistant', content: 'ok' },
    ];
    const ctx = fakeContext(messages);
    const provider = makeFakeProvider([]);
    const c = new IntelligentCompactor({
      provider,
      preserveK: 4,
      summaryCache: new CompactionSummaryCache(),
    });

    const report = await c.compact(ctx, { aggressive: true });

    // preserveK=4 means all 2 pairs are in the preserve window, so no
    // summarizer ran and the report must not claim a completed summary phase.
    expect(report.reductions.some((r) => r.phase === 'summary')).toBe(false);
  });

  it('uses custom thresholds', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const provider = makeFakeProvider([]);
    const c = new IntelligentCompactor({
      provider,
      warnThreshold: 0.3,
      softThreshold: 0.5,
      hardThreshold: 0.8,
      preserveK: 3,
      summaryCache: new CompactionSummaryCache(),
    });

    // No compaction should trigger below warnThreshold
    const report = await c.compact(ctx);
    expect(report.reductions).toHaveLength(0);
  });
});
