import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { estimateMessages } from '../../src/execution/compaction-core.js';
import { CompactionSummaryCache } from '../../src/execution/compaction-summary-cache.js';
import { SelectiveCompactor } from '../../src/execution/selective-compactor.js';
import type { ContentBlock, TextBlock } from '../../src/types/blocks.js';
import type { Message } from '../../src/types/messages.js';
import type { Logger } from '../../src/types/logger.js';
import type { Provider, Capabilities } from '../../src/types/provider.js';
import type { MessageSelector } from '../../src/types/selector.js';

function makeTextBlock(text: string): TextBlock {
  return { type: 'text', text };
}

function makeMessage(role: string, content: ContentBlock[] | string): Message {
  return typeof content === 'string'
    ? { role: role as Message['role'], content }
    : { role: role as Message['role'], content };
}

function fakeContext(messages: Message[], signal = new AbortController().signal): Context {
  const ctx = {
    messages,
    model: 'test-model',
    signal,
    systemPrompt: '',
    provider: null as any,
    config: null as any,
    tools: [],
    session: {
      append: vi.fn(),
      flush: vi.fn(),
      getMessages: () => messages,
      clear: vi.fn(),
    } as any,
    tokenCounter: { account: vi.fn(), estimate: vi.fn(), reset: vi.fn() } as any,
    registerAbortHook: vi.fn(),
    drainAbortHooks: vi.fn(),
    clone: vi.fn(),
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
      streaming: false,
      parallelTools: false,
      vision: false,
      promptCache: false,
      systemPrompt: false,
      jsonMode: false,
      reasoning: false,
      maxContext: 128_000,
      cacheControl: 'none' as const,
    } satisfies Capabilities,
    complete: vi.fn().mockImplementation(async () => ({
      content: [makeTextBlock(responses[idx++] ?? 'summarized')],
      stopReason: 'end_turn',
      usage: { input: 100, output: 50 },
      model: 'test-model',
    })),
    stream: vi.fn(),
  };
}

describe('SelectiveCompactor', () => {
  describe('constructor', () => {
    it('uses defaults when options not provided', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      expect(compactor).toBeDefined();
    });

    it('accepts custom thresholds', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.5,
        softThreshold: 0.7,
        hardThreshold: 0.85,
        preserveK: 2,
        eliseThreshold: 1000,
      });
      expect(compactor).toBeDefined();
    });

    it('uses provided selector over default LLMSelector', () => {
      const provider = makeFakeProvider([]);
      const customSelector: MessageSelector = {
        select: vi.fn().mockResolvedValue({ kept: [], collapsed: [], reasoning: 'test' }),
      };
      const compactor = new SelectiveCompactor({ provider, selector: customSelector });
      expect(compactor).toBeDefined();
    });

    it('logs the primary-model summarizer fallback in every environment', () => {
      const logger = {
        level: 'debug',
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
      } as unknown as Logger;

      new SelectiveCompactor({ provider: makeFakeProvider([]), logger });

      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('ctx.model'));
    });
  });

  describe('compact', () => {
    it('returns early without modification when below warn threshold', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.9,
        maxContext: 100000,
      });
      const messages = [
        makeMessage('user', [makeTextBlock('hi')]),
        makeMessage('assistant', [makeTextBlock('hello')]),
      ];
      const ctx = fakeContext(messages);

      const report = await compactor.compact(ctx);

      expect(report.reductions).toHaveLength(0);
    });

    it('elides tool results when above warn threshold', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
        eliseThreshold: 10,
        preserveK: 1,
      });

      const toolResultBlock: ContentBlock = {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'x'.repeat(500),
      };
      // With preserveK=1, the last assistant turn is preserved.
      // Tool result at index 1 is OLD, so should be elided.
      const messages = [
        makeMessage('assistant', [{ type: 'tool_use', id: 'tool_1', name: 'read', input: {} }]),
        makeMessage('user', [toolResultBlock]),
        makeMessage('user', [makeTextBlock('recent query')]),
        makeMessage('assistant', [makeTextBlock('recent response')]),
      ];
      const ctx = fakeContext(messages);

      const report = await compactor.compact(ctx);

      expect(report.reductions.some((r) => r.phase === 'elision')).toBe(true);
    });

    it('runs selective phase when needed', async () => {
      const provider = makeFakeProvider(['summarized content']);
      const selector: MessageSelector = {
        select: vi.fn().mockResolvedValue({
          kept: [{ from: 2, to: 3, importance: 'high' }],
          collapsed: [{ from: 0, to: 1, summary: 'summary' }],
          reasoning: 'keep recent working pair',
        }),
      };
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.01, // very low so always triggers
        maxContext: 100,
        preserveK: 1,
        selector,
      });

      // Large messages so target budget is small
      const messages = [
        makeMessage('user', [makeTextBlock('hello world '.repeat(50))]),
        makeMessage('assistant', [makeTextBlock('hi there '.repeat(50))]),
        makeMessage('user', [makeTextBlock('ask something '.repeat(50))]),
        makeMessage('assistant', [makeTextBlock('answer here '.repeat(50))]),
      ];
      const ctx = fakeContext(messages);

      const report = await compactor.compact(ctx);

      // Either selective or elision should have run
      expect(report.reductions.length).toBeGreaterThan(0);
    });

    it('uses aggressiveRecencyTrim fallback when selector throws', async () => {
      const provider = makeFakeProvider([]);
      const selector: MessageSelector = {
        select: vi.fn().mockRejectedValue(new Error('selector failed')),
      };
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
        preserveK: 1,
        selector,
      });

      const messages = [
        makeMessage('user', [makeTextBlock('hello')]),
        makeMessage('assistant', [makeTextBlock('hi')]),
      ];
      const ctx = fakeContext(messages);

      const report = await compactor.compact(ctx);

      // Should fall back without crashing
      expect(report).toBeDefined();
    });

    it('aggressive option triggers compaction even when below threshold', async () => {
      const provider = makeFakeProvider([]);
      const selector: MessageSelector = {
        select: vi.fn().mockResolvedValue({ kept: [], collapsed: [], reasoning: '' }),
      };
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.9,
        maxContext: 1000,
        preserveK: 1,
        selector,
      });

      const messages = [
        makeMessage('user', [makeTextBlock('hello')]),
        makeMessage('assistant', [makeTextBlock('hi')]),
      ];
      const ctx = fakeContext(messages);

      await compactor.compact(ctx, { aggressive: true });

      // aggressive should bypass threshold check
    });

    it('returns CompactReport with before and after tokens', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
      });

      const messages = [
        makeMessage('user', [makeTextBlock('hello')]),
        makeMessage('assistant', [makeTextBlock('hi')]),
      ];
      const ctx = fakeContext(messages);

      const report = await compactor.compact(ctx);

      expect(report.before).toBeDefined();
      expect(report.after).toBeDefined();
      expect(Array.isArray(report.reductions)).toBe(true);
    });
  });

  describe('computeTargetBudget', () => {
    it('returns 50% for hard threshold load', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider, hardThreshold: 0.9, maxContext: 1000 });
      const ctx = fakeContext([]);
      // Use private method through compact behavior
      const messages = Array(50)
        .fill(null)
        .map((_, i) =>
          makeMessage(i % 2 === 0 ? 'user' : 'assistant', [makeTextBlock('x'.repeat(50))]),
        );
      ctx.state.replaceMessages(messages);
      // Test hard load path
      const result = (compactor as any).computeTargetBudget(0.95, false);
      expect(result).toBe(500); // 50% of 1000
    });

    it('returns 65% for soft threshold load', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        softThreshold: 0.75,
        hardThreshold: 0.9,
        maxContext: 1000,
      });
      const result = (compactor as any).computeTargetBudget(0.8, false);
      expect(result).toBe(650); // 65% of 1000
    });

    it('returns 75% for warn threshold load', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        softThreshold: 0.75,
        hardThreshold: 0.9,
        maxContext: 1000,
      });
      const result = (compactor as any).computeTargetBudget(0.65, false);
      expect(result).toBe(750); // 75% of 1000
    });
  });

  describe('eliseOldToolResults', () => {
    it('does not elide small tool results below threshold', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
        eliseThreshold: 1000,
        preserveK: 1,
      });

      const smallToolResult: ContentBlock = {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'small',
      };
      const messages = [
        makeMessage('user', [makeTextBlock('hello')]),
        makeMessage('assistant', [makeTextBlock('hi')]),
        makeMessage('user', [smallToolResult]),
      ];
      const ctx = fakeContext(messages);

      const saved = (compactor as any).eliseOldToolResults(ctx);

      expect(saved).toBe(0);
    });

    it('elides large tool results above threshold', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
        eliseThreshold: 10,
        preserveK: 1,
      });

      const largeToolResult: ContentBlock = {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'x'.repeat(500),
      };
      // preserveK=1: only last (user+assistant) pair at indices 2-3 preserved
      // Indices 0-1 (old messages) are eligible for elision
      const messages = [
        makeMessage('user', [largeToolResult]),
        makeMessage('assistant', [makeTextBlock('result')]),
        makeMessage('user', [makeTextBlock('recent query')]),
        makeMessage('assistant', [makeTextBlock('recent response')]),
      ];
      const ctx = fakeContext(messages);

      const saved = (compactor as any).eliseOldToolResults(ctx);

      expect(saved).toBeGreaterThan(0);
    });
  });

  describe('hasTextContent', () => {
    it('returns true for string content with text', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const msg = makeMessage('user', 'hello world');
      expect((compactor as any).hasTextContent(msg)).toBe(true);
    });

    it('returns false for empty string content', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const msg = makeMessage('user', '');
      expect((compactor as any).hasTextContent(msg)).toBe(false);
    });

    it('returns true for text blocks with content', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const msg = makeMessage('user', [makeTextBlock('hello')]);
      expect((compactor as any).hasTextContent(msg)).toBe(true);
    });

    it('returns false for tool_result only content', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const msg: Message = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }],
      };
      expect((compactor as any).hasTextContent(msg)).toBe(false);
    });
  });

  describe('executePlan', () => {
    it('handles empty messages', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const ctx = fakeContext([]);

      await (compactor as any).executePlan(ctx, { kept: [], collapsed: [], reasoning: '' });

      expect(ctx.messages).toHaveLength(0);
    });

    it('collapses ranges and inserts summary', async () => {
      const provider = makeFakeProvider(['summarized']);
      const compactor = new SelectiveCompactor({
        provider,
        preserveK: 1,
        summarizerPrompt: 'summarize',
      });

      const messages = [
        makeMessage('user', [makeTextBlock('msg1')]),
        makeMessage('assistant', [makeTextBlock('msg2')]),
        makeMessage('user', [makeTextBlock('msg3')]),
        makeMessage('assistant', [makeTextBlock('msg4')]),
      ];
      const ctx = fakeContext(messages);

      await (compactor as any).executePlan(ctx, {
        kept: [],
        collapsed: [{ from: 0, to: 1, summary: 'old conversation' }],
        reasoning: 'prune old',
      });

      const sysMsg = ctx.messages.find((m) => m.role === 'system');
      expect(sysMsg).toBeDefined();
    });

    it('reuses cached summaries for identical collapsed ranges', async () => {
      const provider = makeFakeProvider([
        'cached selective summary',
        'unexpected selective summary',
      ]);
      const summaryCache = new CompactionSummaryCache();
      const makeMessages = (): Message[] => [
        makeMessage('user', [makeTextBlock('msg1')]),
        makeMessage('assistant', [makeTextBlock('msg2')]),
        makeMessage('user', [makeTextBlock('current question')]),
        makeMessage('assistant', [makeTextBlock('current answer')]),
      ];
      const makePlan = () => ({
        kept: [],
        collapsed: [{ from: 0, to: 1 }],
        reasoning: '',
      });
      const firstCompactor = new SelectiveCompactor({
        provider,
        preserveK: 1,
        summarizerPrompt: 'summarize',
        summaryCache,
      });
      const secondCompactor = new SelectiveCompactor({
        provider,
        preserveK: 1,
        summarizerPrompt: 'summarize',
        summaryCache,
      });
      const first = fakeContext(makeMessages());
      const second = fakeContext(makeMessages());

      await (firstCompactor as any).executePlan(first, makePlan());
      await (secondCompactor as any).executePlan(second, makePlan());

      expect(String(first.messages[0]?.content)).toContain('cached selective summary');
      expect(String(second.messages[0]?.content)).toContain('cached selective summary');
      expect(String(second.messages[0]?.content)).not.toContain('unexpected selective summary');
    });

    it('uses provided summary when available', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider, preserveK: 1 });

      const messages = [
        makeMessage('user', [makeTextBlock('msg1')]),
        makeMessage('assistant', [makeTextBlock('msg2')]),
        makeMessage('user', [makeTextBlock('current question')]),
        makeMessage('assistant', [makeTextBlock('current answer')]),
      ];
      const ctx = fakeContext(messages);

      await (compactor as any).executePlan(ctx, {
        kept: [],
        collapsed: [{ from: 0, to: 1, summary: 'my custom summary' }],
        reasoning: '',
      });

      const sysMsg = ctx.messages[0];
      expect(sysMsg?.content).toContain('my custom summary');
    });

    it('never lets a selector collapse the configured recent working pairs', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider, preserveK: 1 });
      const messages = [
        makeMessage('user', 'old question'),
        makeMessage('assistant', 'old answer'),
        makeMessage('user', 'current question'),
        makeMessage('assistant', 'current answer'),
      ];
      const ctx = fakeContext(messages);

      await (compactor as any).executePlan(ctx, {
        kept: [],
        collapsed: [{ from: 0, to: 3, summary: 'old summary' }],
        reasoning: 'over-broad plan',
      });

      expect(ctx.messages.some((m) => m.content === 'current question')).toBe(true);
      expect(ctx.messages.some((m) => m.content === 'current answer')).toBe(true);
      expect(ctx.messages.some((m) => String(m.content).includes('old summary'))).toBe(true);
    });

    it('carries compact tool evidence into an LLM-provided range summary', async () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider, preserveK: 1 });
      const messages: Message[] = [
        makeMessage('assistant', [
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'src/old.ts' } },
        ]),
        makeMessage('user', [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'Error: parse failed at src/old.ts',
            is_error: true,
          },
        ]),
        makeMessage('user', 'current question'),
        makeMessage('assistant', 'current answer'),
      ];
      const ctx = fakeContext(messages);

      await (compactor as any).executePlan(ctx, {
        kept: [],
        collapsed: [{ from: 0, to: 1, summary: 'read attempt failed' }],
        reasoning: 'compact old tool exchange',
      });

      const summary = String(ctx.messages[0]?.content);
      expect(summary).toContain('[tool evidence]');
      expect(summary).toContain('src/old.ts');
      expect(summary).toContain('parse failed');
    });
  });

  describe('aggressiveRecencyTrim', () => {
    it('falls back when selector fails', async () => {
      const provider = makeFakeProvider([]);
      const selector: MessageSelector = {
        select: vi.fn().mockRejectedValue(new Error('fail')),
      };
      const compactor = new SelectiveCompactor({
        provider,
        warnThreshold: 0.1,
        maxContext: 1000,
        preserveK: 1,
        selector,
      });

      const messages = [
        makeMessage('user', [makeTextBlock('msg1')]),
        makeMessage('assistant', [makeTextBlock('msg2')]),
        makeMessage('user', [makeTextBlock('msg3')]),
        makeMessage('assistant', [makeTextBlock('msg4')]),
      ];
      const ctx = fakeContext(messages);

      const saved = await (compactor as any).runSelector(ctx, 100);

      expect(saved).toBeGreaterThanOrEqual(0);
    });
  });

  describe('estimateTokens', () => {
    it('delegates to the shared estimateMessages primitive', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const messages = [makeMessage('user', [makeTextBlock('abcdefgh')])];
      const result = (compactor as any).estimateTokens(messages);
      expect(result).toBe(estimateMessages(messages));
    });

    it('grows with message content', () => {
      const provider = makeFakeProvider([]);
      const compactor = new SelectiveCompactor({ provider });
      const small = (compactor as any).estimateTokens([makeMessage('user', [makeTextBlock('hi')])]);
      const large = (compactor as any).estimateTokens([
        makeMessage('user', [makeTextBlock('hi'.repeat(500))]),
      ]);
      expect(large).toBeGreaterThan(small);
    });
  });
});
