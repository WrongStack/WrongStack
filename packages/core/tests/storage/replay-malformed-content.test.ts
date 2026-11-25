import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import {
  applyContextSnapshot,
  isReplayableMessage,
  replayableMessage,
  trackMessageToolState,
} from '../../src/storage/session-store/replay.js';

/**
 * F2231: the journal guard must reject a message whose content array holds a
 * non-block entry. Reaching `trackMessageToolState` with such a message throws
 * and aborts the whole session replay, while the loader is written to skip one
 * damaged event instead (load-session-data.ts:437).
 */
describe('replay of malformed journal content (F2231)', () => {
  it('treats a content array with a non-block entry as a damaged message', () => {
    const malformed = { role: 'user', content: [null] } as unknown;

    expect(isReplayableMessage(malformed)).toBe(false);
    expect(replayableMessage(malformed, '2026-11-25T00:00:00.000Z')).toBeNull();

    const target: Message[] = [];
    expect(applyContextSnapshot(target, new Set<string>(), [malformed])).toBe(false);
    expect(target).toEqual([]);
  });

  it('still accepts string content and every real content-block kind', () => {
    const target: Message[] = [];
    const openToolUses = new Set<string>();
    const applied = applyContextSnapshot(target, openToolUses, [
      { role: 'user', content: 'human instruction' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
    ]);

    expect(applied).toBe(true);
    expect(target).toHaveLength(3);
    expect(openToolUses.size).toBe(0);
    trackMessageToolState(target[0]!, openToolUses);
  });
});
