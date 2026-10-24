import { describe, expect, it } from 'vitest';
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
