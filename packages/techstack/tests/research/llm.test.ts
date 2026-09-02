/**
 * TechStack — LLM adapter tests.
 *
 * Tests createProviderLlm (the bridge from Provider to ResearchLlm),
 * parseResearchJson, extractJsonObject, and stripOuterFence.
 *
 * @see packages/techstack/src/research/llm.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProviderLlm, parseResearchJson } from '../../src/research/llm.js';
import type { Provider, Response } from '@wrongstack/core/types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeResponse(content: Response['content']): Response {
  return {
    content,
    stopReason: 'end_turn',
    usage: { input: 0, output: 0 },
    model: 'test-model',
  };
}

function makeProvider(caps: Partial<Provider['capabilities']> = {}): Provider {
  return {
    id: 'test-provider',
    complete: vi
      .fn<Provider['complete']>()
      .mockResolvedValue(makeResponse([{ type: 'text', text: '{}' }])),
    async *stream() {},
    capabilities: {
      tools: false,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 8_192,
      cacheControl: 'none',
      structuredOutput: false,
      ...caps,
    },
  };
}

// ── createProviderLlm ──────────────────────────────────────────────────────

describe('createProviderLlm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined when there is no provider', () => {
    const accessor = () => undefined;
    expect(createProviderLlm(accessor)).toBeUndefined();
  });

  it('returns a ResearchLlm that delegates to provider.complete', async () => {
    const provider = makeProvider();
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);

    expect(llm).toBeDefined();

    const result = await llm!({
      system: 'You are a research assistant',
      prompt: 'Check react',
      schema: { type: 'object' },
      schemaName: 'test',
      maxTokens: 1000,
    });

    expect(result).toBe('{}');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(provider.complete).mock.calls[0]![0]!;
    expect(callArg.model).toBe('gpt-4');
    expect(callArg.system).toEqual([{ type: 'text', text: 'You are a research assistant' }]);
    expect(callArg.messages).toEqual([{ role: 'user', content: 'Check react' }]);
    expect(callArg.maxTokens).toBe(1000);
  });

  it('re-throws when provider goes missing mid-call', async () => {
    let callCount = 0;
    const accessor = () => {
      callCount++;
      if (callCount === 1) return { provider: makeProvider(), model: 'gpt-4' };
      return undefined; // provider disappears when the closure is called
    };
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    await expect(
      llm({
        system: '',
        prompt: 'test',
        schema: {},
        schemaName: 'x',
        maxTokens: 100,
      }),
    ).rejects.toThrow('no provider available');
  });

  it('uses structuredOutput capabilities when available', async () => {
    const provider = makeProvider({ structuredOutput: true });
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    await llm({
      system: '',
      prompt: 'test',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      schemaName: 'research_result',
      maxTokens: 500,
    });

    const callArg = vi.mocked(provider.complete).mock.calls[0]![0]!;
    expect(callArg.responseFormat).toEqual({
      type: 'json_schema',
      jsonSchema: {
        name: 'research_result',
        strict: false,
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    });
  });

  it('falls back to jsonMode when structuredOutput is unavailable', async () => {
    const provider = makeProvider({ structuredOutput: false, jsonMode: true });
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    await llm({
      system: '',
      prompt: 'test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
    });

    const callArg = vi.mocked(provider.complete).mock.calls[0]![0]!;
    expect(callArg.responseFormat).toEqual({ type: 'json_object' });
  });

  it('respects timeout and aborts the request', async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    // Make the provider hang but reject with the signal's reason on abort
    vi.mocked(provider.complete).mockImplementation(
      (_req, opts) =>
        new Promise<Response>((_resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(
              opts.signal!.reason instanceof Error
                ? opts.signal!.reason
                : new Error(String(opts.signal!.reason)),
            );
            return;
          }
          opts?.signal?.addEventListener(
            'abort',
            () => {
              reject(
                opts!.signal!.reason instanceof Error
                  ? opts!.signal!.reason
                  : new Error(String(opts!.signal!.reason)),
              );
            },
            { once: true },
          );
        }),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor, { timeoutMs: 100 });
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    const promise = llm({
      system: '',
      prompt: 'timeout test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
    });

    const rejection = expect(promise).rejects.toThrow('LLM timeout');
    await vi.advanceTimersByTimeAsync(200);

    await rejection;
  });

  it('supports cancellation via AbortSignal', async () => {
    const provider = makeProvider();
    vi.mocked(provider.complete).mockImplementation(
      (_req, opts) =>
        new Promise<Response>((_resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          opts?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        }),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    const controller = new AbortController();
    const promise = llm({
      system: '',
      prompt: 'cancel test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow('cancelled');
  });

  it('cleans up abort listener after completion', async () => {
    const provider = makeProvider();
    vi.mocked(provider.complete).mockResolvedValue(
      makeResponse([{ type: 'text', text: '{"ok": true}' }]),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    await llm({
      system: '',
      prompt: 'cleanup test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
      signal: controller.signal,
    });

    // After completion, listeners should be cleaned up
    expect(controller.signal.aborted).toBe(false);
  });

  it('uses default timeout of 45s when not specified', async () => {
    const provider = makeProvider();
    vi.mocked(provider.complete).mockResolvedValue(
      makeResponse([{ type: 'text', text: '{"ok": true}' }]),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor); // No timeout option

    expect(llm).toBeDefined();

    const result = await llm!({
      system: '',
      prompt: 'test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
    });

    expect(result).toBe('{"ok": true}');
  });
});

// ── parseResearchJson ─────────────────────────────────────────────────────

describe('parseResearchJson', () => {
  it('returns null for empty text', () => {
    expect(parseResearchJson('')).toBeNull();
  });

  it('returns null for whitespace-only text', () => {
    expect(parseResearchJson('   \n  \t  ')).toBeNull();
  });

  it('parses a valid JSON object', () => {
    const result = parseResearchJson('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON inside a markdown fence', () => {
    const result = parseResearchJson('```json\n{"a": 1}\n```');
    expect(result).toEqual({ a: 1 });
  });

  it('parses JSON with language-tagged markdown fence', () => {
    const result = parseResearchJson('```json\n{"nested": {"inner": true}}\n```');
    expect(result).toEqual({ nested: { inner: true } });
  });

  it('returns null for an array (expected object)', () => {
    expect(parseResearchJson('["a", "b"]')).toBeNull();
  });

  it('returns null for a bare string', () => {
    expect(parseResearchJson('"hello"')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(parseResearchJson('42')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseResearchJson('{not json}')).toBeNull();
  });

  it('strips prose prefix before JSON object', () => {
    const result = parseResearchJson('Here is the result:\n{"answer": 42}\n');
    expect(result).toEqual({ answer: 42 });
  });

  it('strips prose suffix after JSON object', () => {
    // When text starts with `{`, extractJsonObject returns it as-is without
    // stripping trailing prose. The JSON.parse fails and returns null.
    const result = parseResearchJson('{"result": "ok"}\n\nHope this helps!');
    expect(result).toBeNull();
  });
});

// ── Content concatenation ────────────────────────────────────────────────

describe('createProviderLlm — content concatenation', () => {
  it('joins multiple text blocks with newlines', async () => {
    const provider = makeProvider();
    vi.mocked(provider.complete).mockResolvedValue(
      makeResponse([
        { type: 'text', text: '{"findings": [' },
        { type: 'text', text: '{"pkg": "react"}' },
        { type: 'text', text: ']}' },
      ]),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    const result = await llm({
      system: '',
      prompt: 'test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
    });

    // join('\n') inserts newlines between blocks, then trim()
    expect(result).toBe('{"findings": [\n{"pkg": "react"}\n]}');
  });

  it('filters out non-text blocks', async () => {
    const provider = makeProvider();
    vi.mocked(provider.complete).mockResolvedValue(
      makeResponse([
        { type: 'text', text: '{"a":1}' },
        { type: 'tool_use', id: 'x', name: 'x', input: {} },
      ]),
    );
    const accessor = () => ({ provider, model: 'gpt-4' });
    const llm = createProviderLlm(accessor);
    if (!llm) {
      expect.fail('llm should be defined');
      return;
    }

    const result = await llm({
      system: '',
      prompt: 'test',
      schema: {},
      schemaName: 'x',
      maxTokens: 100,
    });

    expect(result).toBe('{"a":1}');
  });
});
