import { describe, expect, it } from 'vitest';
import { generateCommitMessage } from '../src/git-autocommit/commit-message.js';

describe('generateCommitMessage whitespace handling (F1975)', () => {
  it('omits whitespace-only scope and body', () => {
    expect(generateCommitMessage('feat', '   ', ' add login ', '   ')).toBe('feat: add login');
    expect(generateCommitMessage('fix', ' core ', 'bug', ' details ')).toBe(
      'fix(core): bug\n\ndetails',
    );
  });
});
