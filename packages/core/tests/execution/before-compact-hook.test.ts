import type { Message, Provider, SessionWriter, TokenCounter } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { bindContextExtensions, Context } from '../../src/core/context.js';
import { CompactionSummaryCache } from '../../src/execution/compaction-summary-cache.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
import { SelectiveCompactor } from '../../src/execution/selective-compactor.js';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';

function makeProvider(summaryReply = 'Semantic summary of ancient turns.'): Provider {
  return {
    id: 'mock-provider',
    capabilities: {
      streaming: false,
      toolUse: true,
      vision: false,
      maxContext: 8_000,
    },
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: summaryReply }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
    stream: async function* () {
      yield { type: 'message_stop', stopReason: 'end_turn' } as never;
    },
  } as unknown as Provider;
}

function makeSession(id = 'sess_hook_1'): SessionWriter {
  return {
    id,
    append: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionWriter;
}

function makeTokenCounter(): TokenCounter {
  return {
    record: vi.fn(),
    totals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    estimateCost: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
  } as unknown as TokenCounter;
}

function buildLongHistory(): Message[] {
  return [
    { role: 'user', content: 'PINNED_ANCHOR_TURN_0: keep exact schema contract v2' },
    { role: 'assistant', content: 'Acknowledged schema v2.' },
    { role: 'user', content: 'Turn 2 exploration notes' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'orphan_tu', name: 'read', input: { path: 'a.ts' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'orphan_tu', content: 'file body' }],
    },
    { role: 'user', content: 'Turn 5 intermediate step' },
    { role: 'assistant', content: 'Turn 6 intermediate reply' },
    { role: 'user', content: 'Recent tail user turn 7' },
    { role: 'assistant', content: 'Recent tail assistant turn 8' },
  ];
}

function makeContext(provider: Provider, messages: Message[]): Context {
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'System' }],
    provider,
    session: makeSession(),
    signal: new AbortController().signal,
    tokenCounter: makeTokenCounter(),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'mock-model',
  });
  ctx.state.replaceMessages(messages);
  return ctx;
}

describe('beforeCompact extension hook across all compaction strategies', () => {
  it('propagates manual trigger reason, preserves pinned messages, scrubs secrets, and repairs orphaned tool blocks in HybridCompactor via bound Context extensions', async () => {
    const provider = makeProvider();
    const ctx = makeContext(provider, buildLongHistory());
    const extensions = new ExtensionRegistry();
    const reasons: string[] = [];

    extensions.register({
      name: 'pin-and-scrub-ext',
      beforeCompact: async (input) => {
        reasons.push(input.reason);
        return {
          // Pin turn 0 (text) AND turn 3 (orphaned tool_use without its tool_result in turn 4)
          pinnedMessageIndices: [0, 3],
          additionalInstructions: 'Retain key sk-1234567890abcdefghijklmnop safely.',
        };
      },
    });
    bindContextExtensions(ctx, extensions);

    const compactor = createStrategyCompactor({
      strategy: 'hybrid',
      preserveK: 1,
    });
    const report = await compactor.compact(ctx, { aggressive: true, trigger: 'manual' });

    expect(reasons).toEqual(['manual']);
    const joined = ctx.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).toContain('PINNED_ANCHOR_TURN_0: keep exact schema contract v2');
    expect(joined).toContain('[plugin_compaction_notes]');
    expect(joined).not.toContain('sk-1234567890abcdefghijklmnop');
    // Orphaned tool_use from pinned index 3 must be repaired so transcript stays valid
    expect(joined).not.toContain('orphan_tu');
    expect(report.repaired?.removedToolUses).toContain('orphan_tu');
  });

  it('honors pinnedMessageIndices and secret-scrubbed customSummary in IntelligentCompactor without calling provider', async () => {
    const provider = makeProvider();
    const ctx = makeContext(provider, buildLongHistory());
    const extensions = new ExtensionRegistry();

    extensions.register({
      name: 'custom-summary-ext',
      beforeCompact: async () => ({
        pinnedMessageIndices: [0],
        customSummary: 'Custom domain digest (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)',
      }),
    });
    bindContextExtensions(ctx, extensions);

    const compactor = new IntelligentCompactor({
      provider,
      preserveK: 1,
      summaryCache: new CompactionSummaryCache(),
    });
    await compactor.compact(ctx, { aggressive: true, trigger: 'manual' });

    expect(provider.complete).not.toHaveBeenCalled();
    const joined = ctx.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).toContain('Custom domain digest');
    expect(joined).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(joined).toContain('PINNED_ANCHOR_TURN_0: keep exact schema contract v2');
  });

  it('splits collapsed ranges around pinnedMessageIndices and scrubs customSummary in SelectiveCompactor', async () => {
    const provider = makeProvider();
    const ctx = makeContext(provider, buildLongHistory());
    const extensions = new ExtensionRegistry();

    extensions.register({
      name: 'selective-pin-ext',
      beforeCompact: async () => ({
        pinnedMessageIndices: [2],
        customSummary: 'Collapsed slice summary (secret sk-proj-1234567890abcdefghijklmnop)',
      }),
    });
    bindContextExtensions(ctx, extensions);

    const compactor = new SelectiveCompactor({
      provider,
      preserveK: 1,
      maxContext: 100,
      selector: {
        select: async () => ({
          kept: [{ from: 7, to: 8, importance: 'critical' }],
          collapsed: [{ from: 0, to: 6 }],
          reasoning: 'collapse early exploration',
        }),
      },
    });
    await compactor.compact(ctx, { aggressive: true, trigger: 'manual' });

    const joined = ctx.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).toContain('Turn 2 exploration notes');
    expect(joined).toContain('Collapsed slice summary');
    expect(joined).not.toContain('sk-proj-1234567890abcdefghijklmnop');
  });
});
