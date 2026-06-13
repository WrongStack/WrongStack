import { describe, expect, it } from 'vitest';

/**
 * PR 3 of Issue #30 (webui-server 8-PR refactor):
 * characterize `estimateContextBreakdown`. The function
 * stitches together three primitives from
 * `@wrongstack/webui/server` (`estimateTokens`,
 * `messageTokens`, `messagePreview`) into a single
 * per-section report.
 *
 * What the tests pin:
 *
 *   1. Empty inputs: totals are 0, breakdowns are
 *      empty arrays. Pre-refactor: the `.reduce` over
 *      empty arrays returns 0. After extraction: pinned
 *      explicitly so a future "optimize the empty
 *      case" change can't silently break the report.
 *
 *   2. System prompt section: every block's `text` is
 *      tokenized. Missing `text` is treated as empty
 *      string (the `b.text ?? ''` in the helper).
 *
 *   3. Tools section: per-tool token count is the sum
 *      of name + description + schema-stringified
 *      tokens. The shape is `{ name, tokens }`, no
 *      index. Pre-refactor: the tool count in
 *      `tools.count` matches the input array length.
 *
 *   4. Messages section: per-message token count + a
 *      `preview` string. The `index` is the position in
 *      the input array, not the global message number.
 *
 *   5. The `total` is the sum of all three sections.
 *
 *   6. Missing fields (`description`, `inputSchema`)
 *      are treated as empty string / `{}`. Pre-refactor
 *      behavior: `t.description ?? ''` and
 *      `t.inputSchema ?? {}`.
 *
 * The tests do *not* pin exact token counts because
 * the underlying `estimateTokens` is an approximation
 * (chars / 4). They pin the *shape* and the *sum
 * arithmetic*: 3 blocks of "abcd" contribute 3× the
 * token count of one block.
 */

const { estimateContextBreakdown } = await import(
  '../../src/webui-server/context-breakdown.js'
);

describe('estimateContextBreakdown (PR 3 of #30)', () => {
  it('empty inputs: totals are 0, breakdowns are []', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [],
    });
    expect(out.total).toBe(0);
    expect(out.systemPrompt).toBe(0);
    expect(out.tools.total).toBe(0);
    expect(out.tools.count).toBe(0);
    expect(out.tools.breakdown).toEqual([]);
    expect(out.messages.total).toBe(0);
    expect(out.messages.count).toBe(0);
    expect(out.messages.breakdown).toEqual([]);
  });

  it('systemPrompt section: each block contributes its tokens', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [{ text: 'abcd' }, { text: 'abcd' }, { text: 'abcd' }],
      tools: [],
      messages: [],
    });
    expect(out.systemPrompt).toBeGreaterThan(0);
    // 3× the same text → 3× the per-block token count.
    // We assert proportionality, not the exact value,
    // because `estimateTokens` is chars/4 and may
    // change.
    const oneBlock = estimateContextBreakdown({
      systemPrompt: [{ text: 'abcd' }],
      tools: [],
      messages: [],
    });
    expect(out.systemPrompt).toBe(oneBlock.systemPrompt * 3);
  });

  it('systemPrompt with missing `text` is treated as empty string', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [{}, { text: 'abcd' }],
      tools: [],
      messages: [],
    });
    const oneBlock = estimateContextBreakdown({
      systemPrompt: [{ text: 'abcd' }],
      tools: [],
      messages: [],
    });
    expect(out.systemPrompt).toBe(oneBlock.systemPrompt);
  });

  it('tools section: per-tool { name, tokens } shape, no index', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [
        { name: 'a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'bb', description: 'BB', inputSchema: { type: 'object' } },
      ],
      messages: [],
    });
    expect(out.tools.count).toBe(2);
    expect(out.tools.breakdown).toHaveLength(2);
    expect(out.tools.breakdown[0]).toEqual({ name: 'a', tokens: expect.any(Number) });
    expect(out.tools.breakdown[1].name).toBe('bb');
    // name + description + schema tokens
    expect(out.tools.breakdown[0].tokens).toBeGreaterThan(0);
  });

  it('tools: missing description/inputSchema default to empty', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [{ name: 'x' }],
      messages: [],
    });
    // name-only contribution: estimateTokens('x') > 0
    expect(out.tools.breakdown[0].tokens).toBeGreaterThan(0);
  });

  it('messages section: per-message { index, role, tokens, preview }', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [],
      tools: [],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    expect(out.messages.count).toBe(2);
    expect(out.messages.breakdown[0].index).toBe(0);
    expect(out.messages.breakdown[0].role).toBe('user');
    expect(out.messages.breakdown[0].tokens).toBeGreaterThan(0);
    expect(typeof out.messages.breakdown[0].preview).toBe('string');
    expect(out.messages.breakdown[1].index).toBe(1);
    expect(out.messages.breakdown[1].role).toBe('assistant');
  });

  it('total equals the sum of all three sections', () => {
    const out = estimateContextBreakdown({
      systemPrompt: [{ text: 'sys' }],
      tools: [{ name: 't', description: 'D' }],
      messages: [{ role: 'user', content: 'msg' }],
    });
    expect(out.total).toBe(out.systemPrompt + out.tools.total + out.messages.total);
  });
});
