/**
 * The compaction strategy is the conversation's choice.
 *
 * One compactor instance serves every conversation in the process, and the
 * strategy used to be frozen at construction from the boot config. So a
 * strategy picked in a tab went to that tab's meta — where nothing read it —
 * while the compaction every tab actually got stayed whatever the process
 * booted with. The provider is already resolved from `ctx` at compact time for
 * exactly this reason; the strategy is now resolved from the same place.
 *
 * The discriminator below is whether the LLM path is entered at all: `hybrid`
 * is rule-based and never calls the provider, `intelligent`/`selective` do.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';

function stubProvider() {
  const complete = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'summary of earlier turns' }],
    stopReason: 'end_turn' as const,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    id: 'mock',
    capabilities: { streaming: false, tools: false, maxContext: 4000 },
    complete,
  };
}

let transcriptSeq = 0;

/**
 * A conversation over the compaction thresholds, with its own meta bag.
 *
 * Every transcript is unique: the LLM compactors memoise summaries by content,
 * so two byte-identical conversations would let the second one answer from the
 * cache without ever calling the provider — which is the signal these tests
 * read.
 */
function conversation(meta: Record<string, unknown>, provider: unknown) {
  transcriptSeq += 1;
  const tag = `conv-${transcriptSeq}`;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${tag} turn ${i} ${'x'.repeat(400)}`,
  }));
  return {
    meta,
    provider,
    model: 'test-model',
    messages,
    state: {
      revision: 1,
      messages,
      replaceMessages: vi.fn(),
      setMeta: vi.fn(),
      getMeta: vi.fn(),
    },
    session: {
      id: 'sess',
      append: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    },
  } as never;
}

describe('createStrategyCompactor strategy scope', () => {
  it('honours a conversation that asked for hybrid even when the project says selective', async () => {
    const provider = stubProvider();
    const compactor = createStrategyCompactor({ strategy: 'selective' });

    await compactor.compact(conversation({ contextStrategy: 'hybrid' }, provider));

    // Rule-based compaction never asks a model anything.
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('honours a conversation that asked for an LLM strategy when the project says hybrid', async () => {
    const provider = stubProvider();
    const compactor = createStrategyCompactor({ strategy: 'hybrid' });

    await compactor.compact(conversation({ contextStrategy: 'intelligent' }, provider));

    expect(provider.complete).toHaveBeenCalled();
  });

  it('falls back to the project strategy when the conversation named none', async () => {
    const provider = stubProvider();
    const compactor = createStrategyCompactor({ strategy: 'hybrid' });

    await compactor.compact(conversation({}, provider));

    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('ignores a meta value that is not a known strategy', async () => {
    const provider = stubProvider();
    const compactor = createStrategyCompactor({ strategy: 'hybrid' });

    await compactor.compact(conversation({ contextStrategy: 'nonsense' }, provider));

    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('serves two conversations with different strategies from one instance', async () => {
    const compactor = createStrategyCompactor({ strategy: 'hybrid' });
    const quiet = stubProvider();
    const llm = stubProvider();

    await compactor.compact(conversation({ contextStrategy: 'hybrid' }, quiet));
    await compactor.compact(conversation({ contextStrategy: 'intelligent' }, llm));

    expect(quiet.complete).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalled();
  });
});
