import { describe, expect, it } from 'vitest';
import {
  hiddenMessageCount,
  TRANSCRIPT_WINDOW,
  transcriptSearchText,
} from '../src/transcript-window';

describe('conversation rendering window', () => {
  it('renders the newest messages and counts the earlier ones', () => {
    expect(hiddenMessageCount(40, TRANSCRIPT_WINDOW)).toBe(0);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW)).toBe(250);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW * 3)).toBe(0);
    expect(hiddenMessageCount(5, -1)).toBe(5);
  });
});

describe('find in conversation', () => {
  it('searches one line per message, by its visible text', () => {
    const text = transcriptSearchText([
      { role: 'user', text: 'first\nprompt' },
      { role: 'assistant', text: 'an\n\nanswer' },
    ]);
    expect(text.split('\n')).toEqual(['first prompt', 'an answer']);
  });
});
