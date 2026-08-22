import { describe, expect, it } from 'vitest';
import {
  estimateContextBreakdown,
  estimateTokens,
  messagePreview,
  messageTokens,
  stringifyContent,
} from '../src/server/token-estimator.js';

/**
 * Since card #5 (slice 5g) the estimator delegates to core's calibrated
 * basis (3.5 chars/token — see core/src/utils/token-estimate.ts
 * `RoughTokenEstimate`). The old /4 exact-arithmetic fixtures below were
 * updated to the shared basis: 'abcd' → ceil(4/3.5) = 2, not 1. Delegation
 * is the point — these tests pin the WebUI view to the same numbers the
 * CLI/TUI context bar and compaction decisions use.
 */

describe('estimateTokens', () => {
  it('delegates non-empty text to the shared 3.5-chars/token basis', () => {
    expect(estimateTokens('abcd')).toBe(2); // ceil(4/3.5) = 2
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/3.5) = 2
    // Empty presentation fields carry no text and therefore no token cost.
    expect(estimateTokens('')).toBe(0);
  });

  it('handles longer strings on the shared basis', () => {
    // Math.max(1, ceil(len/3.5)) — mirrors RoughTokenEstimate exactly.
    expect(estimateTokens('a'.repeat(100))).toBe(Math.ceil(100 / 3.5));
    expect(estimateTokens('a'.repeat(101))).toBe(Math.ceil(101 / 3.5));
  });

  it('floors single characters at 1 token', () => {
    expect(estimateTokens('x')).toBe(1); // Math.max(1, ceil(1/3.5)) = 1
  });

  it('agrees with the canonical core estimator for mixed content', async () => {
    // The delegation contract: same input, same number as core's public API.
    // Importing core's estimator directly pins the cross-package equality —
    // if the delegation below is ever severed, this fails.
    const { estimateTextTokens } = await import('@wrongstack/core/utils');
    const samples = ['hello world', JSON.stringify({ path: '/x', depth: 2 }), 'a'.repeat(37)];
    for (const s of samples) {
      expect(estimateTokens(s)).toBe(estimateTextTokens(s));
    }
  });
});

describe('stringifyContent', () => {
  it('returns a string unchanged', () => {
    expect(stringifyContent('hello')).toBe('hello');
  });

  it('JSON stringifies an object', () => {
    expect(stringifyContent({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');
  });

  it('JSON stringifies an array', () => {
    expect(stringifyContent([1, 2, 3])).toBe('[1,2,3]');
  });

  it('falls back to String() on circular reference', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const result = stringifyContent(obj);
    // Should not throw; falls back to String()
    expect(result).toBe(String(obj));
  });

  it('handles null', () => {
    expect(stringifyContent(null)).toBe('null');
  });

  it('handles numbers', () => {
    expect(stringifyContent(42)).toBe('42');
  });

  it('handles undefined (JSON.stringify returns raw undefined)', () => {
    // JSON.stringify(undefined) returns the JS value undefined (not a string),
    // so stringifyContent returns undefined for undefined input
    expect(stringifyContent(undefined)).toBeUndefined();
  });
});

describe('messageTokens', () => {
  it('estimates tokens for a string content', () => {
    expect(messageTokens('hello world')).toBe(estimateTokens('hello world'));
  });

  it('returns 0 for non-array, non-string content', () => {
    expect(messageTokens(42)).toBe(0);
    expect(messageTokens(null)).toBe(0);
    expect(messageTokens({})).toBe(0);
  });

  it('handles text blocks', () => {
    const content = [{ type: 'text', text: 'Hello, how can I help you?' }];
    expect(messageTokens(content)).toBe(estimateTokens('Hello, how can I help you?'));
  });

  it('handles text blocks with missing text', () => {
    const content = [{ type: 'text' }];
    expect(messageTokens(content)).toBe(0);
  });

  it('handles tool_use blocks via the canonical tool-input estimator', () => {
    const content = [{ type: 'tool_use', name: 'read_file', input: { path: '/test.txt' } }];
    // Delegates to estimateToolInputTokens (core): strings pass through,
    // objects go through the cached JSON basis — same 3.5 divisor.
    expect(messageTokens(content)).toBe(
      Math.ceil(JSON.stringify({ path: '/test.txt' }).length / 3.5),
    );
  });

  it('handles tool_result blocks via the canonical tool-result estimator', () => {
    const content = [{ type: 'tool_result', content: 'file contents here' }];
    // Strings pass straight through the shared basis (no JSON re-quoting).
    expect(messageTokens(content)).toBe(Math.ceil('file contents here'.length / 3.5));
  });

  it('handles unknown block types gracefully', () => {
    const content = [{ type: 'image', source: { url: '...' } }];
    // Falls through to stringifyContent of the whole block
    expect(messageTokens(content)).toBeGreaterThan(0);
  });

  it('sums tokens across multiple blocks', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', name: 'read', input: { file: 'x' } },
      { type: 'tool_result', content: 'result data' },
    ];
    const expected =
      estimateTokens('Hello') +
      Math.ceil(JSON.stringify({ file: 'x' }).length / 3.5) +
      Math.ceil('result data'.length / 3.5);
    expect(messageTokens(content)).toBe(expected);
  });
});

describe('messagePreview', () => {
  it('returns first 60 chars of a string content', () => {
    expect(messagePreview('hello world')).toBe('hello world');
    const long = 'a'.repeat(100);
    expect(messagePreview(long)).toBe('a'.repeat(60));
  });

  it('returns empty string for non-array, non-string content', () => {
    expect(messagePreview(42)).toBe('');
    expect(messagePreview(null)).toBe('');
    expect(messagePreview({})).toBe('');
  });

  it('previews text blocks with first 40 chars', () => {
    const content = [{ type: 'text', text: 'Hello, how can I help you today?' }];
    const preview = messagePreview(content);
    expect(preview).toBe('Hello, how can I help you today?');
    expect(preview.length).toBeLessThanOrEqual(60);
  });

  it('previews tool_use blocks', () => {
    const content = [{ type: 'tool_use', name: 'read_file' }];
    expect(messagePreview(content)).toBe('[tool_use: read_file]');
  });

  it('previews tool_result blocks', () => {
    const content = [{ type: 'tool_result', content: 'data' }];
    expect(messagePreview(content)).toBe('[tool_result]');
  });

  it('handles unknown block types', () => {
    const content = [{ type: 'image_block', source: { url: '...' } }];
    expect(messagePreview(content)).toBe('[image_block]');
  });

  it('truncates combined preview to 60 chars', () => {
    const content = [
      { type: 'text', text: 'This is a very long text that goes well beyond sixty characters' },
      { type: 'tool_result', content: 'more data' },
    ];
    const preview = messagePreview(content);
    expect(preview.length).toBeLessThanOrEqual(60);
  });

  it('handles text blocks with undefined text', () => {
    const content = [{ type: 'text' }];
    expect(messagePreview(content)).toBe('');
  });
});

describe('estimateContextBreakdown', () => {
  it('computes a full breakdown with empty inputs', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [],
    });
    expect(result).toEqual({
      total: 0,
      systemPrompt: 0,
      tools: { total: 0, count: 0, breakdown: [] },
      messages: { total: 0, count: 0, breakdown: [] },
    });
  });

  it('includes system prompt tokens', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [{ text: 'You are a helpful assistant.' }],
      tools: [],
      messages: [],
    });
    expect(result.systemPrompt).toBeGreaterThan(0);
    expect(result.total).toBe(result.systemPrompt);
  });

  it('handles system prompt blocks with missing text', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [{ text: undefined }],
      tools: [],
      messages: [],
    });
    expect(result.systemPrompt).toBe(0);
  });

  it('includes tool breakdown with schema and description', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [],
      tools: [{ name: 'read_file', inputSchema: { type: 'object' }, description: 'Read a file' }],
      messages: [],
    });
    expect(result.tools.count).toBe(1);
    expect(result.tools.total).toBeGreaterThan(0);
    expect(result.tools.breakdown[0].name).toBe('read_file');
    expect(result.tools.breakdown[0].tokens).toBeGreaterThan(0);
  });

  it('handles tools with empty schema and description', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [],
      tools: [{ name: 'empty_tool' }],
      messages: [],
    });
    expect(result.tools.count).toBe(1);
    expect(result.tools.total).toBeGreaterThan(0);
  });

  it('includes message breakdown', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      ],
    });
    expect(result.messages.count).toBe(2);
    expect(result.messages.total).toBeGreaterThan(0);
    expect(result.messages.breakdown[0].role).toBe('user');
    expect(result.messages.breakdown[1].role).toBe('assistant');
  });

  it('computes total as sum of all parts', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [{ text: 'You are a helpful assistant that can use tools.' }],
      tools: [
        {
          name: 'read_file',
          inputSchema: { type: 'object', properties: {} },
          description: 'Read a file from disk',
        },
        {
          name: 'write_file',
          inputSchema: { type: 'object' },
          description: 'Write a file to disk',
        },
      ],
      messages: [
        { role: 'user', content: 'Read the config file for me.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll read that file now." },
            { type: 'tool_use', name: 'read_file', input: { path: '/config.json' } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', content: JSON.stringify({ key: 'value' }) }],
        },
      ],
    });
    expect(result.total).toBe(result.systemPrompt + result.tools.total + result.messages.total);
    expect(result.total).toBeGreaterThan(0);
  });

  it('handles messages with non-array, non-string content', () => {
    const result = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [{ role: 'system', content: 42 }],
    });
    expect(result.messages.breakdown[0].tokens).toBe(0);
  });

  it('WebUI estimate matches the canonical core basis (~14% divergence gone)', () => {
    // Smoke comparison pinning the unification contract: for a representative
    // mixed payload, the delegated figure must equal core's own public text
    // estimator, and must read ~14% higher than the retired /4 figure.
    const payload = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the config and applying the schema now.' },
        { type: 'tool_use', name: 'read_file', input: { path: '/config.json', mode: 'strict' } },
        { type: 'tool_result', content: JSON.stringify({ key: 'value', nested: { deep: true } }) },
      ],
    });
    const delegated = estimateTokens(payload);
    const coreBasis = Math.max(1, Math.ceil(payload.length / 3.5));
    const retiredWebUiBasis = Math.ceil(payload.length / 4);

    expect(delegated).toBe(coreBasis); // exact match with canonical estimator
    expect(delegated).toBeGreaterThan(retiredWebUiBasis); // conservative shift is real
    // The historical ~14% divergence between surfaces: 4/3.5 ≈ 1.143.
    const ratio = delegated / retiredWebUiBasis;
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThanOrEqual(4 / 3.5 + 0.01);
  });
});
