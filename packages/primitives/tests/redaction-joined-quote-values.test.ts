/**
 * F1225: quoted and unquoted pieces that touch — `'a'"b c"`, `"a"'b c'`,
 * `a"b c"` — are ONE shell word (POSIX sh and PowerShell concatenate them).
 * The secret patterns stopped after the first piece and printed the rest of
 * the secret after `[REDACTED]`.
 */
import { describe, expect, it } from 'vitest';
import { redactCommand, redactSecrets } from '../src/redact-command.js';

const profiles = [redactCommand, redactSecrets];

describe('secret values written as joined quoted pieces', () => {
  it.each([
    [`PASSWORD='fixture'"private tail" ./run`, 'PASSWORD=[REDACTED] ./run'],
    [`PASSWORD="fixture"'private tail' ./run`, 'PASSWORD=[REDACTED] ./run'],
    [`mysql --password='fixture'"private tail" db`, 'mysql --password=[REDACTED] db'],
    [`mysql --password=fixture"private tail" db`, 'mysql --password=[REDACTED] db'],
    [`mysql -p 'fixture'"private tail" db`, 'mysql -p [REDACTED] db'],
    [`curl --cookie 'sid=fixture'"private tail" https://x`, 'curl --cookie [REDACTED] https://x'],
  ])('conceals the whole word %s', (input, expected) => {
    for (const redact of profiles) {
      const output = redact(input);
      expect(output).toBe(expected);
      expect(redact(output)).toBe(output);
    }
  });

  it('still ends the value at a shell metacharacter or a separate quoted word', () => {
    for (const redact of profiles) {
      expect(redact(`$env:API_KEY = 'fixture'; run`)).toBe('$env:API_KEY [REDACTED]; run');
      expect(redact(`mysql -p 'fixture' "db name"`)).toBe('mysql -p [REDACTED] "db name"');
      expect(redact(`echo "TOKEN=abc" && echo "hi"`)).toBe('echo "TOKEN=[REDACTED] && echo "hi"');
      expect(redact(`echo "TOKEN=abc"; echo "hi"`)).toBe('echo "TOKEN=[REDACTED]; echo "hi"');
    }
  });
});
