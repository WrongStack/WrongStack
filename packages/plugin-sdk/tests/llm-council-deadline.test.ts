import { afterEach, describe, expect, it, vi } from 'vitest';
import { noOpLogger } from '../../core/src/infrastructure/logger.js';
import { makePluginLLM } from '../../core/src/plugin/plugin-llm.js';
import { ProviderRegistry } from '../../core/src/registry/provider-registry.js';
import { CONFIG_BEHAVIOR_DEFAULTS } from '../../core/src/storage/config-loader/defaults.js';
import type { CouncilResult } from '../../core/src/types/council.js';
import type { Provider } from '../../core/src/types/provider.js';
import { runOptionalPluginCouncil } from '../src/runtime/llm.js';

function fixture() {
  const complete = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'fallback' }],
    stopReason: 'end_turn' as const,
    usage: { input: 1, output: 1 },
    model: 'fixture',
  }));
  const provider: Provider = {
    id: 'fixture',
    capabilities: {
      tools: false,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 1000,
      cacheControl: 'none',
    },
    async *stream() {
      yield* [];
    },
    complete,
  };
  const council = vi.fn(() => new Promise<CouncilResult>(() => {}));
  const config = {
    ...CONFIG_BEHAVIOR_DEFAULTS,
    provider: 'fixture',
    model: 'fixture',
    extensions: { fixture: { llm: { timeoutMs: 1000 } } },
  };
  const llm = makePluginLLM(
    'fixture',
    { provider, model: 'fixture', council },
    new ProviderRegistry(),
    config,
    () => config,
    { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    noOpLogger,
  );
  return { llm, council, complete };
}

afterEach(async () => {
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('optional Council deadline', () => {
  it('control: the real host honors an explicit Council deadline', async () => {
    vi.useFakeTimers();
    const { llm } = fixture();
    const outcome = llm.council?.('question', { timeoutMs: 50 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(49);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(new Error('Plugin "fixture" Council request timed out'));
  });

  it('reaches One Shot fallback at the requested Council deadline', async () => {
    vi.useFakeTimers();
    const { llm, complete, council } = fixture();
    let value: string | null | undefined;
    const pending = runOptionalPluginCouncil({
      requested: true,
      prompt: 'question',
      label: 'fixture',
      api: { llm, log: noOpLogger },
      options: { timeoutMs: 50 },
      parse: (text) => text,
    }).then((result) => {
      value = result.value;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(value).toBeUndefined();
    expect(council).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(value, 'FAIL: SDK Council ignored the requested 50ms deadline').toBe('fallback');
    expect(complete).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('keeps the host default when no deadline is supplied', async () => {
    vi.useFakeTimers();
    const { llm, complete } = fixture();
    let value: string | null | undefined;
    const pending = runOptionalPluginCouncil({
      requested: true,
      prompt: 'question',
      label: 'fixture',
      api: { llm, log: noOpLogger },
      parse: (text) => text,
    }).then((result) => {
      value = result.value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(value).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(value).toBe('fallback');
  });
});
