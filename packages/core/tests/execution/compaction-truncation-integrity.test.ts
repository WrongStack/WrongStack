/**
 * Regressions in the compaction text paths:
 *  - eliseOldToolResults rebuilt an elided tool_result without `name` (every
 *    sibling elision path keeps it), so after the first compaction Gemini's
 *    functionResponse.name fell back to the tool_use_id.
 *  - Every compaction cut site sliced by UTF-16 unit and could split a
 *    surrogate pair, sending a lone surrogate (unpaired `\ud83d` JSON escape)
 *    to the provider.
 */

import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import {
  buildSmartDigest,
  eliseOldToolResults,
  enforceHardBudget,
  headTailTruncate,
} from '../../src/execution/compaction-core.js';
import { sliceUtf16Safe } from '../../src/execution/compaction-scoring.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function toolHistory(resultText: string, inputText = 'a.ts'): Message[] {
  return [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { file_path: inputText } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', name: 'read', content: resultText }],
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'done' },
  ] as Message[];
}

describe('eliseOldToolResults keeps the tool name', () => {
  it('preserves tool_result.name on the elided block', () => {
    const result = eliseOldToolResults(toolHistory('line\n'.repeat(3_000)), {
      preserveK: 2,
      eliseThreshold: 2000,
    });
    expect(result.changed).toBe(true);
    const block = (result.messages[2]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    expect(block['name']).toBe('read');
    expect(String(block['content'])).toMatch(/^\[elided: ~/);
  });

  it('adds no name key to a block that never had one', () => {
    const history = toolHistory('line\n'.repeat(3_000));
    delete (history[2]!.content as Array<{ name?: string }>)[0]!.name;
    const result = eliseOldToolResults(history, { preserveK: 2, eliseThreshold: 2000 });
    const block = (result.messages[2]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    expect('name' in block).toBe(false);
  });
});

describe('compaction cuts never split a surrogate pair', () => {
  it('headTailTruncate head and tail cuts stay well-formed', () => {
    const out = headTailTruncate(`x${'😀'.repeat(2_000)}`, 800, 300);
    expect(out).not.toMatch(LONE);
    expect(out).toContain('[truncated ~');
  });

  it('enforceHardBudget emergency trim stays well-formed', () => {
    const result = enforceHardBudget(
      [
        { role: 'user', content: `y${'🚀'.repeat(3_000)}` },
        { role: 'assistant', content: 'ok' },
      ],
      200,
      { preserveK: 1 },
    );
    expect(String(result.messages[0]!.content)).not.toMatch(LONE);
  });

  it('elided tool_use field summary and tool_result excerpt stay well-formed', () => {
    const result = eliseOldToolResults(
      toolHistory(`ww${'🔥'.repeat(3_000)}`, `z${'🎉'.repeat(3_000)}`),
      {
        preserveK: 2,
        eliseThreshold: 500,
      },
    );
    const use = (result.messages[1]!.content as Array<{ input: unknown }>)[0]!;
    const res = (result.messages[2]!.content as Array<{ content: string }>)[0]!;
    expect(JSON.stringify(use.input)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
    expect(res.content).not.toMatch(LONE);
  });

  it('smart digest cuts stay well-formed', () => {
    const digest = buildSmartDigest([
      { role: 'user', content: `a${'✨🔥'.repeat(200)}` },
      { role: 'assistant', content: `b${'🙂'.repeat(200)}` },
    ]);
    expect(digest).not.toMatch(LONE);
  });

  it('ASCII output is unchanged and aligned cuts drop nothing', () => {
    const ascii = 'abcdefghij\n'.repeat(200);
    expect(headTailTruncate(ascii, 800, 300)).toBe(
      `${ascii.slice(0, 800)}\n… [truncated ~${Math.ceil((ascii.length - 1100) / 3.5)} tokens — see session log] …\n${ascii.slice(ascii.length - 300)}`,
    );
    const pairs = '😀'.repeat(10);
    expect(sliceUtf16Safe(pairs, 0, 8)).toBe(pairs.slice(0, 8));
    expect(sliceUtf16Safe(pairs, 0, 9)).toBe(pairs.slice(0, 8));
    expect(sliceUtf16Safe(pairs, 11)).toBe(pairs.slice(12));
    expect(sliceUtf16Safe('ab\uD83Dcd', 0, 3)).toBe('ab\uD83D'); // pre-existing lone kept
  });
});
