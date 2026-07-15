import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
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

function makeFakeProvider(responses: string[]): Provider {
  let idx = 0;
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
      maxContext: 128000,
      cacheControl: 'none',
    },
    stream() {
      return (async function* () {})();
    },
    async complete(_req) {
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
  it('elides large old tool results via elision phase', async () => {
    const big = 'x'.repeat(20_000);
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
    const c = new IntelligentCompactor({ provider, preserveK: 3, eliseThreshold: 1000 });
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
    const c = new IntelligentCompactor({ provider, preserveK: 2, maxContext: 10 });

    const report = await c.compact(ctx, { aggressive: true });

    // Provider should have been called for summarization in aggressive mode.
    // The summary now also includes buildSmartDigest enrichment for critical content.
    expect(report.reductions.some((r) => r.phase === 'summary')).toBe(true);
  });

  it('uses summarizer response as the summary text', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const provider = makeFakeProvider(['custom summary']);
    const c = new IntelligentCompactor({ provider, preserveK: 3 });

    await c.compact(ctx, { aggressive: true });

    // The summary message should contain our custom text
    const summaryMsg = ctx.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('custom summary'),
    );
    expect(summaryMsg).toBeDefined();
  });

  it('falls back to placeholder on provider error', async () => {
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
    const c = new IntelligentCompactor({ provider: badProvider, preserveK: 3 });

    const report = await c.compact(ctx, { aggressive: true });

    // Should still produce a report without crashing
    expect(report).toBeDefined();
    expect(report.reductions).toBeDefined();
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
    const c = new IntelligentCompactor({ provider, preserveK: 4 });

    const report = await c.compact(ctx, { aggressive: true });

    // preserveK=4 means all 2 pairs are in the preserve window
    // no summarization should occur — phase is recorded with 0 savings
    const summaryReduction = report.reductions.find((r) => r.phase === 'summary');
    expect(summaryReduction?.saved).toBe(0);
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
    });

    // No compaction should trigger below warnThreshold
    const report = await c.compact(ctx);
    expect(report.reductions).toHaveLength(0);
  });
});
