import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider } from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ConversationState } from '../../src/core/conversation-state.js';
import { compactionReportStillCurrent } from '../../src/execution/compaction-result-state.js';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';

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

function ownedJournalContext(
  messages: Message[],
  writer: Context['session'],
  provider?: Provider,
): Context {
  const ctx = {
    messages,
    todos: [],
    meta: {},
    tools: [],
    systemPrompt: [],
    model: 'test-model',
    messageLimits: { maxMessages: 0, maxMessageTokens: 0 },
    session: writer,
    provider,
    signal: new AbortController().signal,
  } as unknown as Context;
  Object.defineProperty(ctx, 'state', { value: new ConversationState(ctx) });
  return ctx;
}

describe('compaction snapshot writer ownership', () => {
  it('marks the report stale when the session changes during the durability flush', async () => {
    const next = {
      id: 'next',
      append: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    } as unknown as Context['session'];
    const first = {
      id: 'first',
      append: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    } as unknown as Context['session'];
    const ctx = ownedJournalContext(manyTurns(), first);
    first.flush = async () => {
      ctx.session = next;
    };
    const after = vi.fn();
    const compactor = createStrategyCompactor({ preserveK: 3 });
    compactor.observe?.({ after });
    const report = await compactor.compact(ctx, { aggressive: true });
    expect(compactionReportStillCurrent(report, ctx)).toBe(false);
    expect(after).not.toHaveBeenCalled();
    expect(next.append).not.toHaveBeenCalled();
  });
  it('journals an active run through its pinned writer', async () => {
    const liveAppend = vi.fn(async () => undefined);
    const pinnedAppend = vi.fn(async () => undefined);
    const ctx = ownedJournalContext(manyTurns(), {
      id: 'live',
      append: liveAppend,
      flush: vi.fn(async () => undefined),
    } as unknown as Context['session']);
    ctx.activeRunSessionWriter = {
      id: 'pinned',
      append: pinnedAppend,
      flush: vi.fn(async () => undefined),
    } as unknown as Context['session'];
    await createStrategyCompactor({ preserveK: 3 }).compact(ctx, { aggressive: true });
    expect(pinnedAppend).toHaveBeenCalledOnce();
    expect(liveAppend).not.toHaveBeenCalled();
  });

  it('does not snapshot an earlier compaction into a newly selected session after an LLM await', async () => {
    const previousAppend = vi.fn(async () => undefined);
    const nextAppend = vi.fn(async () => undefined);
    const provider = makeProvider();
    const messages = manyTurns();
    messages.splice(
      1,
      0,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'old-read', name: 'read', input: { path: 'old.txt' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'old-read', content: 'old output '.repeat(10000) },
        ],
      },
    );
    const ctx = ownedJournalContext(
      messages,
      {
        id: 'previous',
        append: previousAppend,
        flush: vi.fn(async () => undefined),
      } as unknown as Context['session'],
      provider,
    );
    provider.complete = async () => {
      ctx.session = {
        id: 'next',
        append: nextAppend,
        flush: vi.fn(async () => undefined),
      } as unknown as Context['session'];
      return {
        model: 'test-model',
        content: [{ type: 'text', text: 'old summary' }],
        stopReason: 'end_turn',
        usage: { input: 100, output: 1 },
      };
    };
    const report = await createStrategyCompactor({
      strategy: 'intelligent',
      preserveK: 3,
      eliseThreshold: 100,
    }).compact(ctx, { aggressive: true });
    expect(report.reductions.some((r) => r.phase === 'elision' && r.saved > 0)).toBe(true);
    expect(nextAppend).not.toHaveBeenCalled();
  });
});
