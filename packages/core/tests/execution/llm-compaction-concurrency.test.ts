import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type { MessageSelector } from '@wrongstack/contracts/types/selector';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ConversationState } from '../../src/core/conversation-state.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import { CompactionSummaryCache } from '../../src/execution/compaction-summary-cache.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
import { SelectiveCompactor } from '../../src/execution/selective-compactor.js';
import type { SessionEventBridge } from '../../src/storage/session-event-bridge.js';

function turns(prefix: string): Message[] {
  return Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${prefix} ${i} ` + 'ordinary text '.repeat(30),
  }));
}

function context(): Context {
  const ctx = {
    messages: turns('original'),
    todos: [],
    meta: {},
    tools: [],
    systemPrompt: [],
    messageLimits: { maxMessages: 0, maxMessageTokens: 0 },
    model: 'test',
    clearFileTracking: () => {},
    signal: new AbortController().signal,
  } as unknown as Context;
  Object.defineProperty(ctx, 'state', { value: new ConversationState(ctx) });
  return ctx;
}

const kinds = ['intelligent summary', 'selective selector', 'selective summary'] as const;

function compactor(ctx: Context, kind: (typeof kinds)[number], mutate: () => void) {
  const provider = {
    id: 'compaction-race',
    capabilities: { maxContext: 1000 },
    complete: async () => {
      mutate();
      return {
        model: 'test',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'summary of ORIGINAL history' }],
        usage: { input: 10, output: 1 },
      };
    },
  } as unknown as Provider;
  ctx.provider = provider;
  const summaryCache = new CompactionSummaryCache();
  if (kind === 'intelligent summary')
    return new IntelligentCompactor({ provider, maxContext: 1000, preserveK: 2, summaryCache });
  const selector: MessageSelector = {
    select: async () => {
      if (kind === 'selective selector') mutate();
      return {
        kept: [],
        collapsed: [
          {
            from: 0,
            to: 10,
            ...(kind === 'selective selector' ? { summary: 'summary of ORIGINAL history' } : {}),
          },
        ],
        reasoning: 'compact',
      };
    },
  };
  return new SelectiveCompactor({
    provider,
    selector,
    maxContext: 1000,
    preserveK: 2,
    summaryCache,
  });
}

describe('LLM compaction concurrency', () => {
  it.each(kinds)('does not overwrite a replaced history after awaiting %s', async (kind) => {
    const ctx = context();
    const replacement = turns('CURRENT history');
    const c = compactor(ctx, kind, () => ctx.state.replaceMessages(replacement));
    await c.compact(ctx, { aggressive: true });
    expect(ctx.messages).toEqual(replacement);
  });

  it.each(kinds)('preserves messages appended while awaiting %s', async (kind) => {
    const ctx = context();
    const queued: Message = { role: 'user', content: 'concurrent queued user input' };
    const c = compactor(ctx, kind, () => ctx.state.appendMessage(queued));
    await c.compact(ctx, { aggressive: true });
    expect(ctx.messages).toContainEqual(queued);
  });
});

describe('LLM compaction cancellation', () => {
  it.each(kinds)('does not apply a late plan after cancellation during %s', async (kind) => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const original = [...ctx.messages];
    const c = compactor(ctx, kind, () => controller.abort());
    await c.compact(ctx, { aggressive: true });
    expect(ctx.messages).toHaveLength(original.length);
    expect(ctx.messages.map((m) => m.content)).toEqual(original.map((m) => m.content));
  });
});

describe('automatic compaction cancellation', () => {
  it.each(kinds)('does not emergency-trim history after cancellation during %s', async (kind) => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const original = [...ctx.messages];
    const c = compactor(ctx, kind, () => controller.abort());
    const mw = new AutoCompactionMiddleware(c, 1000, undefined, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    await mw.handler()(ctx, async (current) => current);
    expect(ctx.messages).toHaveLength(original.length);
    expect(ctx.messages.map((m) => m.content)).toEqual(original.map((m) => m.content));
  });
});

describe('automatic compaction after a concurrent history edit', () => {
  it.each(kinds)('does not emergency-trim the replacement history after stale %s', async (kind) => {
    const ctx = context();
    const replacement = turns('CURRENT history');
    const c = compactor(ctx, kind, () => ctx.state.replaceMessages(replacement));
    const mw = new AutoCompactionMiddleware(c, 1000, undefined, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    await mw.handler()(ctx, async (current) => current);
    expect(ctx.messages).toHaveLength(replacement.length);
    expect(ctx.messages).toEqual(replacement);
  });

  it('does not use a hybrid report after history changes before its awaiting caller resumes', async () => {
    const ctx = context();
    ctx.provider = {
      id: 'hybrid-report-race',
      capabilities: { maxContext: 1000 },
    } as unknown as Provider;
    const replacement = turns('CURRENT history');
    const mw = new AutoCompactionMiddleware(
      new HybridCompactor({ preserveK: 2 }),
      1000,
      undefined,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
    );
    const pending = mw.handler()(ctx, async (current) => current);
    ctx.state.replaceMessages(replacement);
    await pending;
    expect(ctx.messages).toHaveLength(replacement.length);
    expect(ctx.messages).toEqual(replacement);
  });
});

describe('stale compaction failure and journal boundaries', () => {
  it.each(kinds)('preserves replacement history when a stale %s rejects', async (kind) => {
    const ctx = context();
    const replacement = turns('CURRENT history');
    const c = compactor(ctx, kind, () => {
      ctx.state.replaceMessages(replacement);
      throw new Error('stale LLM failure');
    });
    const mw = new AutoCompactionMiddleware(c, 1000, undefined, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    await mw.handler()(ctx, async (current) => current);
    expect(ctx.messages).toHaveLength(replacement.length);
    expect(ctx.messages).toEqual(replacement);
  });

  it('rechecks report provenance after awaiting the compaction journal bridge', async () => {
    const ctx = context();
    ctx.provider = {
      id: 'bridge-report-race',
      capabilities: { maxContext: 1000 },
    } as unknown as Provider;
    const replacement = turns('CURRENT history');
    let journaled = false;
    const bridge = {
      append: async () => {
        journaled = true;
        ctx.state.replaceMessages(replacement);
      },
    } as unknown as SessionEventBridge;
    const mw = new AutoCompactionMiddleware(
      new HybridCompactor({ preserveK: 2 }),
      1000,
      undefined,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { sessionBridge: bridge },
    );
    await mw.handler()(ctx, async (current) => current);
    expect(journaled).toBe(true);
    expect(ctx.messages).toHaveLength(replacement.length);
    expect(ctx.messages).toEqual(replacement);
  });
});
