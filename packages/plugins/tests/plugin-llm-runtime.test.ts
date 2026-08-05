import { describe, expect, it, vi } from 'vitest';
import {
  parseLlmJsonObject,
  runOptionalPluginCouncil,
  runOptionalPluginLlm,
  stripOuterMarkdownFence,
} from '../src/runtime/llm.js';

function makeApi(complete?: ReturnType<typeof vi.fn>, council?: ReturnType<typeof vi.fn>) {
  return {
    llm: complete || council ? { complete, council } : undefined,
    log: { warn: vi.fn() },
  };
}

describe('plugin LLM runtime helpers', () => {
  it('strips only one outer Markdown fence', () => {
    expect(stripOuterMarkdownFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripOuterMarkdownFence('before\n```ts\ncode\n```')).toContain('```ts');
  });

  it('parses only JSON objects', () => {
    expect(parseLlmJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseLlmJsonObject('[1,2,3]')).toBeNull();
    expect(parseLlmJsonObject('not json')).toBeNull();
  });

  it('reports unavailable without throwing when no host LLM is wired', async () => {
    const result = await runOptionalPluginLlm({
      requested: true,
      api: makeApi(),
      label: 'test',
      prompt: 'prompt',
      parse: (text) => text,
    });
    expect(result).toEqual({ used: false, value: null, fallbackReason: 'unavailable' });
  });

  it('returns parsed output on success', async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{"answer":42}' });
    const result = await runOptionalPluginLlm({
      requested: true,
      api: makeApi(complete),
      label: 'test',
      prompt: 'prompt',
      parse: parseLlmJsonObject,
    });
    expect(result).toEqual({ used: true, value: { answer: 42 }, fallbackReason: null });
  });

  it('turns invalid responses and provider errors into explicit fallbacks', async () => {
    const invalidApi = makeApi(vi.fn().mockResolvedValue({ text: 'bad' }));
    const invalid = await runOptionalPluginLlm({
      requested: true,
      api: invalidApi,
      label: 'test',
      prompt: 'prompt',
      parse: parseLlmJsonObject,
    });
    expect(invalid.fallbackReason).toBe('invalid-response');
    expect(invalidApi.log.warn).toHaveBeenCalled();

    const errorApi = makeApi(vi.fn().mockRejectedValue(new Error('offline')));
    const failed = await runOptionalPluginLlm({
      requested: true,
      api: errorApi,
      label: 'test',
      prompt: 'prompt',
      parse: (text) => text,
    });
    expect(failed.fallbackReason).toBe('provider-error');
    expect(errorApi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('deterministic fallback'),
      expect.objectContaining({ error: 'offline' }),
    );
  });

  it('does not start an LLM request after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn();
    const result = await runOptionalPluginLlm({
      requested: true,
      api: makeApi(complete),
      label: 'test',
      prompt: 'prompt',
      options: { signal: controller.signal },
      parse: (text) => text,
    });
    expect(result.fallbackReason).toBe('cancelled');
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses Council for consequential analysis and falls back to One Shot on invalid output', async () => {
    const council = vi.fn().mockResolvedValue({
      status: 'decided',
      answer: '{"answer":42}',
      resolution: 'judge',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const complete = vi.fn().mockResolvedValue({ text: '{"answer":7}' });
    const result = await runOptionalPluginCouncil({
      requested: true,
      api: makeApi(complete, council) as never,
      label: 'test',
      profile: 'risk-review',
      prompt: 'assess risk',
      parse: parseLlmJsonObject,
    });
    expect(result.value).toEqual({ answer: 42 });
    expect(council).toHaveBeenCalledWith(
      'assess risk',
      expect.objectContaining({ profile: 'risk-review' }),
    );
    expect(complete).not.toHaveBeenCalled();

    council.mockResolvedValueOnce({ status: 'failed', resolution: 'none', usage: {} });
    const fallback = await runOptionalPluginCouncil({
      requested: true,
      api: makeApi(complete, council) as never,
      label: 'test',
      prompt: 'assess risk',
      parse: parseLlmJsonObject,
    });
    expect(fallback.value).toEqual({ answer: 7 });
    expect(complete).toHaveBeenCalled();
  });
});
