import type { Message } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { searchProjectHistory } from '../src/server/project-history-search.js';
import {
  findTranscriptMatches,
  projectSessionTranscript,
} from '../src/server/session-transcript.js';

/**
 * F1392: transcript search found the match in `text.toLowerCase()` and cut the
 * excerpt / page window from the original text at that index. `İ` (U+0130)
 * lowercases to two code units, so the window drifted right of the match and,
 * past the end of the text, `textWindow` threw: the whole conversation came back
 * as a search error instead of a hit.
 */

const turkish = `${'İZMİR '.repeat(150)}needle tail`;
const messages = (content: string): Message[] => [{ role: 'user', content }];

describe('transcript search with dotted capital I (F1392)', () => {
  it('returns the conversation as a hit whose excerpt contains the match', async () => {
    const summary = { id: 's1', title: 'T', startedAt: '2026-11-22T00:00:00.000Z' };
    const store = {
      list: async () => [summary],
      load: async () => ({ messages: messages(turkish) }),
    };
    const result = await searchProjectHistory(store as never, { query: 'needle' }, 'carrier');
    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.hits[0]!.excerpt).toContain('needle');
  });

  it('centres a short excerpt on the match and finds İ with a lowercase query', () => {
    const { hits } = findTranscriptMatches(messages(`${'İ'.repeat(120)} needle`), 'needle', '');
    expect(hits[0]!.excerpt).toContain('needle');
    expect(findTranscriptMatches(messages('İstanbul'), 'istanbul', '').matching).toBe(1);
  });

  it('opens a transcript page on the match past the first text chunk', () => {
    const text = `${'a'.repeat(16_000)}${'İ'.repeat(400)} needle tail`;
    const page = projectSessionTranscript(messages(text), { query: 'needle' });
    const block = page.messages[0]!.blocks[0] as { text: string };
    expect(block.text).toContain('needle');
  });
});
