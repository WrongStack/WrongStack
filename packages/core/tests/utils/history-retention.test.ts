import { describe, expect, it } from 'vitest';
import { eliseOldToolResults } from '../../src/execution/compaction-core.js';
import { getHistoryRetention } from '../../src/execution/history-retention.js';
import { estimateMessageTokens, type Message } from '../../src/index.js';

const user = (text: string): Message => ({ role: 'user', content: text });
const assistant = (text: string): Message => ({ role: 'assistant', content: text });
const toolCall = (id: string, input: Record<string, unknown> = { path: 'a.ts' }): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'read', input }],
});
const toolResult = (id: string, content: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});

describe('getHistoryRetention', () => {
  it('classifies digests, protected tail, elided, elision candidates and compactable turns', () => {
    const messages: Message[] = [
      { role: 'system', content: '[context_state]\ngoal: ship it' },
      user('old question'),
      toolCall('t1'),
      toolResult('t1', 'x'.repeat(20_000)),
      toolCall('t2'),
      toolResult('t2', '[elided: read a.ts — 400 lines]'),
      assistant('old answer'),
      user('recent question'),
      assistant('recent answer'),
    ];
    const r = getHistoryRetention({
      messages,
      meta: { contextWindowPolicy: { preserveK: 2, eliseThreshold: 1_000 } },
    });

    expect(r.preserveK).toBe(2);
    expect(r.eliseThreshold).toBe(1_000);
    expect(r.preserveStart).toBe(7);
    expect(r.classes.digest.messages).toBe(1);
    expect(r.classes.protected.messages).toBe(2);
    expect(r.classes['elision-candidate'].messages).toBe(1);
    expect(r.classes.elided.messages).toBe(1);
    expect(r.classes.compactable.messages).toBe(4);
    expect(r.total).toBe(estimateMessageTokens(messages));
  });

  it('falls back to the compaction policy defaults', () => {
    const r = getHistoryRetention({ messages: [user('hi')] });
    expect(r.preserveK).toBe(6);
    expect(r.eliseThreshold).toBe(1_200);
    expect(r.classes.protected.messages).toBe(1);
  });
});

// The report's own header promises it "mirrors the compactors' own window and
// the policy defaults ... so the classes match what compaction will actually
// do". `eliseOldToolResults` decides that per block: it scans every block of a
// turn and calls it oversized at `tokensFor(b) >= eliseThreshold`, scoring an
// existing receipt 0. `classify()` used to short-circuit on the first receipt,
// compare with `>` and ignore `tool_use` inputs entirely, so three kinds of
// turn were reported as settled work while the engine still meant to rewrite
// them — and CLI `/context residency`, the TUI context panel and the WebUI
// Context X-Ray all read those buckets.
describe('getHistoryRetention matches the elision engine per turn', () => {
  const THRESHOLD = 1_000;
  const policy = { contextWindowPolicy: { preserveK: 2, eliseThreshold: THRESHOLD } };
  /** ceil(3500 / 3.5) === 1000: oversized for the engine, which uses `>=`. */
  const EXACT = 'y'.repeat(3_500);
  const HUGE = 'x'.repeat(20_000);
  const RECEIPT = '[elided: read src/a.ts — 400 lines]';

  const results = (...blocks: string[]): Message => ({
    role: 'user',
    content: blocks.map((text, i) => ({
      type: 'tool_result' as const,
      tool_use_id: `t${i}`,
      content: text,
    })),
  });

  /** Oldest turn plus a recent tail, so the turn sits inside the elision window. */
  const convo = (oldTurn: Message): Message[] => [
    oldTurn,
    user('q1'),
    assistant('a1'),
    user('q2'),
    assistant('a2'),
  ];
  const candidates = (messages: Message[]): number =>
    getHistoryRetention({ messages, meta: policy }).classes['elision-candidate'].messages;

  it('reports a turn holding a receipt plus a still-oversized result as a candidate', () => {
    const messages = convo(results(RECEIPT, HUGE));
    expect(eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: THRESHOLD }).changed).toBe(
      true,
    );
    expect(candidates(messages)).toBe(1);
    expect(getHistoryRetention({ messages, meta: policy }).classes.elided.messages).toBe(0);
  });

  it('reports a turn sitting exactly on the threshold as a candidate', () => {
    const messages = convo(results(EXACT));
    expect(eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: THRESHOLD }).changed).toBe(
      true,
    );
    expect(candidates(messages)).toBe(1);
  });

  it('reports a turn whose only oversized block is a tool_use input as a candidate', () => {
    const turn: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 't0',
          name: 'write',
          input: { path: 'src/big.ts', content: 'z'.repeat(20_000) },
        },
      ],
    };
    const messages = convo(turn);
    expect(eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: THRESHOLD }).changed).toBe(
      true,
    );
    expect(candidates(messages)).toBe(1);
  });

  it('still reports a turn with nothing left to replace as elided', () => {
    const messages = convo(results(RECEIPT));
    expect(eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: THRESHOLD }).changed).toBe(
      false,
    );
    const r = getHistoryRetention({ messages, meta: policy });
    expect(r.classes['elision-candidate'].messages).toBe(0);
    expect(r.classes.elided.messages).toBe(1);
  });
});
