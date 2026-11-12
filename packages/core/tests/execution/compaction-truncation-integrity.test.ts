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

  it('emergency trim refuses a tool_use receipt that would grow the block', () => {
    // Site 3: elideMessageToolIo (the budget path's writer of
    // summarizeToolUseInputElision, floor EMERGENCY_MIN_TRIM_TOKENS = 120, far below
    // the 500 elision threshold) rewrote the input unconditionally. The receipt
    // copies every string <= 160 chars out of `fields` VERBATIM and only ADDS its
    // wrapper, so this 136-token input became 166 - counted as a trim, i.e. the
    // last-resort overflow path reporting relief while adding to the overflow.
    // Driven through enforceHardBudget, the production caller, so nothing here is
    // wired to an export only tests use.
    const growable = {
      a: `alpha ${'y'.repeat(144)}`,
      b: `bravo ${'z'.repeat(144)}`,
      c: `charlie ${'w'.repeat(143)}`,
    };
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'grow-e', name: 'clarify', input: growable }],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'grow-e', content: 'answered' }],
      } as Message,
      { role: 'user', content: 'recent' } as Message,
    ];

    // A budget no receipt can reach: the only honest answer is "no relief here",
    // never a rewrite that makes the prompt larger.
    const result = enforceHardBudget(messages, 1, { preserveK: 1 });
    const wire = JSON.stringify(result.messages);

    expect(result.trimmedBlocks).toBe(0);
    expect(wire).not.toContain('__elided_tool_input');
    expect(result.droppedMessages).toBe(2);
  });

  it('emergency trim still shrinks a tool_use input that really does compress', () => {
    // Control for the guard above: refusing a growing receipt must not disable the
    // overflow path for inputs that actually compress.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'shrink-e',
            name: 'write',
            input: { path: 'src/generated.ts', content: 'export const value = 1;\n'.repeat(600) },
          },
        ],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'shrink-e', content: 'ok' }],
      } as Message,
      { role: 'user', content: 'recent' } as Message,
    ];

    const result = enforceHardBudget(messages, 300, { preserveK: 1 });
    const wire = JSON.stringify(result.messages);

    expect(result.trimmedBlocks).toBeGreaterThan(0);
    expect(wire).toContain('__elided_tool_input');
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
