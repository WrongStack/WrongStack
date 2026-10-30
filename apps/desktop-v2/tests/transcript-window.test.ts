import { describe, expect, it } from 'vitest';
import { hiddenMessageCount, TRANSCRIPT_WINDOW } from '../src/transcript-window';

describe('conversation rendering window', () => {
  it('renders the newest messages and counts the earlier ones', () => {
    expect(hiddenMessageCount(40, TRANSCRIPT_WINDOW)).toBe(0);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW)).toBe(250);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW * 3)).toBe(0);
    expect(hiddenMessageCount(5, -1)).toBe(5);
  });
});
