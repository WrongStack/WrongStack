/**
 * The static fallback rules' regexes, checked against the file forms their own
 * `fileExtensions` claim to cover.
 */
import { describe, expect, it } from 'vitest';
import { getSecretPatterns } from '../src/skill-patterns.js';

function matches(line: string): boolean {
  const rule = getSecretPatterns('nodejs').find((pattern) => pattern.id === 'hardcoded-secrets');
  return (rule?.patterns ?? []).some((regex) => {
    regex.lastIndex = 0;
    return regex.test(line);
  });
}

describe('hardcoded-secrets rule', () => {
  it('matches a quoted key, as in the .json and .yaml files it lists (F1288)', () => {
    expect(matches('const password = "hunter2hunter2";')).toBe(true);
    expect(matches('  "password": "hunter2hunter2",')).toBe(true);
    expect(matches("  'api_key': 'abcdefgh12345',")).toBe(true);
    // The key word must end the key: `max_tokens` is not a `token` key.
    expect(matches('  "max_tokens": "abcdefgh12345"')).toBe(false);
  });
});
