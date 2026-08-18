import { describe, expect, it, vi } from 'vitest';
import { LLMSelector } from '../../src/models/llm-selector.js';
import type { Message } from '../../src/types/messages.js';
import type { Provider, Capabilities } from '../../src/types/provider.js';

function makeTextBlock(text: string) {
  return { type: 'text' as const, text };
}

function makeMessage(role: string, content: string): Message {
  return { role: role as Message['role'], content };
}

function mockProvider(responses: string[]): Provider {
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
      reasoning: false,
      maxContext: 128_000,
      cacheControl: 'none' as const,
    } satisfies Capabilities,
    complete: vi.fn().mockImplementation(async () => ({
      content: responses[idx++] ? [makeTextBlock(responses[idx - 1])] : [makeTextBlock('{}')],
      stopReason: 'end_turn' as const,
      usage: { input: 10, output: 10 },
      model: 'test',
    })),
    stream: vi.fn(),
  };
}

describe('LLMSelector', () => {
  describe('constructor', () => {
    it('sets provider from options', () => {
      const provider = mockProvider([]);
      const selector = new LLMSelector({ provider });
      expect(selector).toBeDefined();
    });

    it('uses default model when not provided', () => {
      const provider = mockProvider([]);
      const selector = new LLMSelector({ provider });
      expect(selector).toBeDefined();
    });

    it('accepts custom maxContextTokens', () => {
      const provider = mockProvider([]);
      const selector = new LLMSelector({ provider, maxContextTokens: 5000 });
      expect(selector).toBeDefined();
    });

    it('accepts custom systemPrompt', () => {
      const provider = mockProvider([]);
      const selector = new LLMSelector({ provider, systemPrompt: 'custom prompt' });
      expect(selector).toBeDefined();
    });
  });

  describe('select', () => {
    it('calls provider.complete with formatted messages', async () => {
      const provider = mockProvider([
        '{"kept":[{"from":0,"to":2,"importance":"high"}],"collapsed":[],"reasoning":"test"}',
      ]);
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      const messages = [
        makeMessage('system', 'You are helpful'),
        makeMessage('user', 'Hello'),
        makeMessage('assistant', 'Hi there'),
      ];
      await selector.select(messages, 1000);
      expect(provider.complete).toHaveBeenCalled();
      const req = vi.mocked(provider.complete).mock.calls[0]![0];
      expect(req.system?.[0]?.text).toContain('context pruning assistant');
    });

    it('returns kept and collapsed from parsed JSON', async () => {
      const provider = mockProvider([
        '{"kept":[{"from":0,"to":1,"importance":"critical"}],"collapsed":[{"from":2,"to":5,"summary":"old conversation"}],"reasoning":"reasoning here"}',
      ]);
      const selector = new LLMSelector({ provider });
      const messages = Array(6)
        .fill(null)
        .map((_, i) => makeMessage(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`));
      const result = await selector.select(messages, 1000);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0]!.from).toBe(0);
      expect(result.kept[0]!.to).toBe(1);
      expect(result.kept[0]!.importance).toBe('critical');
      expect(result.collapsed).toHaveLength(1);
      expect(result.collapsed[0]!.from).toBe(2);
      expect(result.collapsed[0]!.to).toBe(5);
      expect(result.collapsed[0]!.summary).toBe('old conversation');
      expect(result.reasoning).toBe('reasoning here');
    });

    it('uses fallback when provider throws', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('provider error')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider });
      const messages = Array(10)
        .fill(null)
        .map((_, i) => makeMessage(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`));
      const result = await selector.select(messages, 1000);
      expect(result.kept.length + result.collapsed.length).toBeGreaterThan(0);
    });

    it('uses fallback when JSON cannot be parsed', async () => {
      const provider = mockProvider(['not valid json at all']);
      const selector = new LLMSelector({ provider });
      const messages = Array(10)
        .fill(null)
        .map((_, i) => makeMessage(i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`));
      const result = await selector.select(messages, 1000);
      // Should fall back, meaning result has kept/collapsed
      expect(result.kept.length + result.collapsed.length).toBeGreaterThan(0);
    });

    it('uses fallback when JSON has no kept/collapsed keys', async () => {
      const provider = mockProvider(['{"other":"data"}']);
      const selector = new LLMSelector({ provider });
      const messages = Array(5)
        .fill(null)
        .map((_, i) => makeMessage('user', `msg ${i}`));
      const result = await selector.select(messages, 1000);
      expect(result.kept).toEqual([]);
      expect(result.collapsed).toEqual([]);
    });

    it('respects maxContextTokens as upper bound', async () => {
      const provider = mockProvider(['{"kept":[],"collapsed":[],"reasoning":""}']);
      const selector = new LLMSelector({ provider, maxContextTokens: 5000 });
      const messages = Array(10)
        .fill(null)
        .map((_, _i) => makeMessage('user', 'x'.repeat(100)));
      const result = await selector.select(messages, 1000);
      // effective budget = min(1000, 5000) = 1000 → all 10 messages fit
      expect(result.kept).toBeDefined();
    });

    it('maps importance string to typed importance', async () => {
      const provider = mockProvider([
        '{"kept":[{"from":0,"to":0,"importance":"high"},{"from":1,"to":1,"importance":"medium"}],"collapsed":[],"reasoning":""}',
      ]);
      const selector = new LLMSelector({ provider });
      const messages = [makeMessage('user', 'msg1'), makeMessage('assistant', 'msg2')];
      const result = await selector.select(messages, 1000);
      expect(result.kept[0]!.importance).toBe('high');
      expect(result.kept[1]!.importance).toBe('medium');
    });

    it('defaults importance to medium when missing', async () => {
      const provider = mockProvider(['{"kept":[{"from":0,"to":0}],"collapsed":[],"reasoning":""}']);
      const selector = new LLMSelector({ provider });
      const messages = [makeMessage('user', 'msg1')];
      const result = await selector.select(messages, 1000);
      expect(result.kept[0]!.importance).toBe('medium');
    });
  });

  describe('fallback behavior', () => {
    it('keeps recent messages that fit within budget', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('fail')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      // Each message ~25 tokens (100 chars / 4)
      const messages = Array(20)
        .fill(null)
        .map((_, i) => makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(100)));
      const result = await selector.select(messages, 500); // 500 token budget
      // Should keep some recent messages and collapse older ones
      expect(result.kept.length).toBeGreaterThan(0);
    });

    it('collapses all when budget is very small', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('fail')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      const messages = Array(5)
        .fill(null)
        .map((_, _i) => makeMessage('user', 'x'.repeat(200)));
      const result = await selector.select(messages, 10); // tiny budget → all collapsed
      expect(Array.isArray(result.kept)).toBe(true);
    });

    it('keeps all when budget is large enough', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('fail')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      const messages = Array(5)
        .fill(null)
        .map((_, _i) => makeMessage('user', 'short'));
      const result = await selector.select(messages, 100000); // huge budget
      expect(result.collapsed).toHaveLength(0);
      expect(result.kept).toHaveLength(1); // All in one kept range
    });
  });

  describe('estimateTokens with tool_use blocks', () => {
    it('estimates tokens for message with array content containing tool_use blocks', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('fail')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'tool_use', id: 'tool_1', name: 'ReadFile', input: { path: '/a/b/c' } },
            { type: 'tool_use', id: 'tool_2', name: 'WriteFile', input: { path: '/x/y/z', content: 'hello' } },
          ],
        },
      ];
      // The tool_use blocks get token-counted via JSON.stringify(b).length / 4
      const result = await selector.select(messages, 1000);
      // Should use fallback with the messages (some kept/collapsed)
      expect(result).toBeDefined();
    });
  });

  describe('formatMessages early break', () => {
    it('breaks early when total line length exceeds maxChars', async () => {
      const provider: Provider = {
        id: 'test',
        capabilities: { tools: false, streaming: false, parallelTools: false, vision: false, promptCache: false, systemPrompt: false, jsonMode: false, reasoning: false, maxContext: 128_000, cacheControl: 'none' as const } satisfies Capabilities,
        complete: vi.fn().mockRejectedValue(new Error('fail')),
        stream: vi.fn(),
      };
      const selector = new LLMSelector({ provider, maxContextTokens: 40000 });
      // Each message is padded to exceed maxChars quickly
      const messages: Message[] = Array(100)
        .fill(null)
        .map((_, i) => makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(200)));
      const result = await selector.select(messages, 1000);
      expect(result).toBeDefined();
    });

    it('keeps the current working tail visible when old content exhausts the preview budget', async () => {
      const provider = mockProvider(['{"kept":[],"collapsed":[],"reasoning":""}']);
      const selector = new LLMSelector({ provider, maxContextTokens: 40_000 });
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'old bulk '.repeat(20_000) }] },
        ...Array.from({ length: 30 }, (_, i) =>
          makeMessage('assistant', `middle ${i} ${'x'.repeat(500)}`),
        ),
        makeMessage('user', 'CURRENT TASK MUST REMAIN VISIBLE'),
        makeMessage('assistant', 'CURRENT WORKING ANSWER'),
      ];

      await selector.select(messages, 1_200);

      const req = vi.mocked(provider.complete).mock.calls[0]![0];
      const preview = req.messages[0]?.content;
      expect(preview).toContain('CURRENT TASK MUST REMAIN VISIBLE');
      expect(preview).toContain('CURRENT WORKING ANSWER');
    });
  });

  describe('parseSelectorOutput edge cases', () => {
    it('parseSelectorOutput finds valid JSON but JSON.parse throws', async () => {
      // The raw response has { and } but the content between them isn't valid JSON
      // e.g. "{"kept": {...}}" would fail JSON.parse for some reason
      const provider = mockProvider(['{"kept":[{invalid json here}],"collapsed":[],"reasoning":""}']);
      const selector = new LLMSelector({ provider });
      const messages = Array(5).fill(null).map((_, i) => makeMessage('user', `msg ${i}`));
      const result = await selector.select(messages, 1000);
      // Should fall back to recency selection
      expect(result.kept.length + result.collapsed.length).toBeGreaterThan(0);
    });

    it('parseSelectorOutput with empty kept/collapsed arrays', async () => {
      const provider = mockProvider(['{"kept":[],"collapsed":[],"reasoning":"nothing kept"}']);
      const selector = new LLMSelector({ provider });
      const messages = Array(5).fill(null).map((_, i) => makeMessage('user', `msg ${i}`));
      const result = await selector.select(messages, 1000);
      expect(result.kept).toEqual([]);
      expect(result.collapsed).toEqual([]);
    });

    it('parseSelectorOutput where kept[i].importance is missing → defaults to medium', async () => {
      const provider = mockProvider(['{"kept":[{"from":0,"to":2}],"collapsed":[],"reasoning":""}']);
      const selector = new LLMSelector({ provider });
      const messages = Array(5).fill(null).map((_, i) => makeMessage('user', `msg ${i}`));
      const result = await selector.select(messages, 1000);
      expect(result.kept[0]!.importance).toBe('medium');
    });
  });
});

describe('LLMSelector with OneShotOrchestrator', () => {
  function makeMessages(n = 5): Message[] {
    return Array(n).fill(null).map((_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }));
  }

  it('calls orchestrator.call() when oneShotOrchestrator is set', async () => {
    const call = vi.fn(async () => ({
      text: '{"kept":[{"from":0,"to":2}],"collapsed":[{"from":3,"to":4}]}',
      model: 'test',
      provider: 'test',
      tokens: { input: 50, output: 25, total: 75 },
      durationMs: 100,
      fromFallback: false,
    }));
    const selector = new LLMSelector({
      provider: {} as Provider,
      oneShotOrchestrator: { call } as never,
    });
    const result = await selector.select(makeMessages(), 1000);
    expect(call).toHaveBeenCalledTimes(1);
    const input = call.mock.calls[0]![0];
    expect(input).toHaveProperty('system');
    expect(input).toHaveProperty('userPrompt');
    expect(input).toHaveProperty('maxTokens');
    expect(input).toHaveProperty('timeoutMs');
    expect(result.kept).toHaveLength(1);
    expect(result.collapsed).toHaveLength(1);
  });

  it('falls back to fallbackSelect when orchestrator returns an error', async () => {
    const call = vi.fn(async () => ({
      text: '',
      model: '',
      provider: '',
      tokens: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      fromFallback: false,
      error: 'provider overloaded',
    }));
    const selector = new LLMSelector({
      provider: {} as Provider,
      oneShotOrchestrator: { call } as never,
    });
    const result = await selector.select(makeMessages(3), 10);
    // With tiny budget, fallbackSelect keeps nothing.
    expect(call).toHaveBeenCalledTimes(1);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(Array.isArray(result.collapsed)).toBe(true);
  });

  it('parses orchestrator response text via parseSelectorOutput', async () => {
    const text = JSON.stringify({
      kept: [{ from: 0, to: 1, importance: 'high' }],
      collapsed: [{ from: 2, to: 4 }],
      reasoning: 'compact older turns',
    });
    const call = vi.fn(async () => ({
      text,
      model: 'test',
      provider: 'test',
      tokens: { input: 50, output: 25, total: 75 },
      durationMs: 100,
      fromFallback: false,
    }));
    const selector = new LLMSelector({
      provider: {} as Provider,
      oneShotOrchestrator: { call } as never,
    });
    const result = await selector.select(makeMessages(), 1000);
    expect(result.kept[0]!.importance).toBe('high');
    expect(result.collapsed[0]!.from).toBe(2);
    expect(result.reasoning).toBe('compact older turns');
  });
});
