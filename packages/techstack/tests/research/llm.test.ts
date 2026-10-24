/**
 * TechStack — LLM adapter tests.
 *
 * Tests createProviderLlm (the bridge from Provider to ResearchLlm),
 * parseResearchJson, extractJsonObject, and stripOuterFence.
 *
 * @see packages/techstack/src/research/llm.ts
 */

import type { Provider, Response } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderLlm, parseResearchJson } from '../../src/research/llm.js';

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

  // Previous version of this test asserted `toBeNull()`: the name said "strips
  // prose suffix" while the assertion pinned the failure, so a model reply with a
  // friendly closing line silently dropped the whole cluster's findings.
  // `extractJsonObject` now rescues the balanced object instead.
  it('strips prose suffix after JSON object', () => {
    const result = parseResearchJson('{"result": "ok"}\n\nHope this helps!');
    expect(result).toEqual({ result: 'ok' });
  });

  it('ignores braces in the surrounding prose', () => {
    const result = parseResearchJson(
      'The range {>=1.0} is fine.\n{"answer": 42}\nSee {docs} for details.',
    );
    expect(result).toEqual({ answer: 42 });
  });

  // Regression: a maxTokens-cut cluster response is a valid JSON prefix whose
  // outermost object never closes. Before the repair pass, parseResearchJson
  // returned null and the cluster contributed zero findings silently. After
  // the repair, the parser must close the cut string + any unclosed
  // object/array containers and surface every finding whose object completed
  // before the cut.
  it('repairs a truncated prefix and recovers the complete finding inside it', () => {
    const truncated =
      '{"findings":[{"id":"trunc-complete-1","severity":"high","dependencyName":"truncated-pkg","summary":"truncated summary","rationale":"truncated rationale","sources":[{"title":"src","url":"https://example.test","snippet":"snip"}]},{"id":"trunc-partial-2","severity":"med';
    const result = parseResearchJson(truncated);
    expect(result).not.toBeNull();
    expect(Array.isArray(result?.findings)).toBe(true);
    const findings = (result as { findings: Array<{ id: string }> }).findings;
    expect(findings[0]?.id).toBe('trunc-complete-1');
  });

  it('repairs a truncated prefix that cuts mid-string value', () => {
    const truncated = '{"answer": "the migration guide suggests upgradi';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'the migration guide suggests upgradi' });
  });

  it('repairs a truncated prefix that cuts mid-array', () => {
    const truncated = '{"items": [1, 2, 3,';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it('returns null for a truncated prefix with no recoverable anchor', () => {
    // No `{` to anchor on — the repair helper bails and the parser falls
    // through to the r25 "let JSON.parse throw and return null" path.
    const result = parseResearchJson('"hello');
    expect(result).toBeNull();
  });

  // Regression: the cut can land mid-escape — right after a `\` that was
  // opening the next escape of a `C:\\Windows\\…` value, or inside a partial
  // `\uXXXX`. The closing quote the repair appends is then swallowed by the
  // escape (`\"`) or invalidates it (`\uD83"`), the string never closes, and
  // the cluster degrades to zero findings exactly as if the repair pass did
  // not exist. The interrupted escape is dropped before closing the string.
  it('repairs a truncated prefix cut right after a backslash in a string value', () => {
    // JSON text: {"answer": "path C:\Windows\  — ends on ONE unpaired `\`
    // (cut between the two chars of an intended `\\`).
    const truncated = '{"answer": "path C:\\\\Windows\\';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'path C:\\Windows' });
  });

  it('repairs a truncated prefix cut inside a partial \\uXXXX escape', () => {
    // JSON text: {"answer": "emoji \uD83  — cut before the 4th hex digit.
    const truncated = '{"answer": "emoji \\uD83';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'emoji ' });
  });

  it('keeps a complete escaped backslash at the cut when closing the string', () => {
    // JSON text: {"answer": "path C:\\Windows\\  — the trailing `\\` is a
    // COMPLETE escape, so the repair must close after it, not strip it.
    const truncated = '{"answer": "path C:\\\\Windows\\\\';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'path C:\\Windows\\' });
  });

  it('keeps a complete \\uXXXX escape at the cut when closing the string', () => {
    // JSON text: {"answer": "star \u2605  — all 4 hex digits present.
    const truncated = '{"answer": "star \\u2605';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'star \u2605' });
  });

  it('keeps a complete escape earlier in a cut string value', () => {
    // JSON text: {"answer": "line1\nline2  — the \n must survive the repair.
    const truncated = '{"answer": "line1\\nline2';
    const result = parseResearchJson(truncated);
    expect(result).toEqual({ answer: 'line1\nline2' });
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
