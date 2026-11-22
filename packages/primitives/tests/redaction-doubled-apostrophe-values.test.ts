/**
 * F1210: `'it''s secret'` is ONE shell word — PowerShell reads `''` as an
 * escaped apostrophe and POSIX sh concatenates the adjacent quoted strings.
 * The long-flag patterns already kept the pair inside the value; the
 * env-style, short-flag, user-credential and `--cookie` patterns stopped at the
 * first apostrophe and printed the rest of the secret after `[REDACTED]`.
 */
import { describe, expect, it } from 'vitest';
import { redactCommand, redactSecrets } from '../src/redact-command.js';

const profiles = [redactCommand, redactSecrets];

describe('doubled apostrophes inside single-quoted secret values', () => {
  it.each([
    ["PASSWORD='fixture''s private tail' ./run", 'PASSWORD=[REDACTED] ./run'],
    ["$env:API_KEY = 'fixture''s private tail'; run", '$env:API_KEY [REDACTED]; run'],
    ["redis-cli -a 'fixture''s private tail' ping", 'redis-cli -a [REDACTED] ping'],
    ["mysql -p 'fixture''s private tail' db", 'mysql -p [REDACTED] db'],
    ["curl -u 'alice:fixture''s private tail' https://x", 'curl -u [REDACTED] https://x'],
    ["curl -u 'o''brien:fixture tail' https://x", 'curl -u [REDACTED] https://x'],
    ["curl --cookie 'sid=fixture''s private tail' https://x", 'curl --cookie [REDACTED] https://x'],
  ])('conceals the whole value of %s', (input, expected) => {
    for (const redact of profiles) {
      const output = redact(input);
      expect(output).toBe(expected);
      expect(redact(output)).toBe(output);
    }
  });

  it('does not consume a following quoted public argument', () => {
    for (const redact of profiles) {
      expect(redact("PASSWORD='fixture''s tail' --label 'public text'")).toBe(
        "PASSWORD=[REDACTED] --label 'public text'",
      );
      expect(redact("redis-cli -a 'pw''x' --label 'public text'")).toBe(
        "redis-cli -a [REDACTED] --label 'public text'",
      );
    }
  });

  it('keeps empty values, unclosed quotes and ordinary text working', () => {
    for (const redact of profiles) {
      expect(redact("PASSWORD='' ./run")).toBe('PASSWORD=[REDACTED] ./run');
      expect(redact("PASSWORD='fixture\nnext 'line'")).toBe("PASSWORD=[REDACTED]\nnext 'line'");
      expect(redact('sudo -u root ls')).toBe('sudo -u root ls');
      expect(redact("echo 'it''s fine' --label 'x'")).toBe("echo 'it''s fine' --label 'x'");
    }
  });
});
