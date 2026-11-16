import { describe, expect, it } from 'vitest';
import { redactCommand, redactSecrets } from '../src/redact-command.js';

const profiles = [redactCommand, redactSecrets];

describe('PowerShell doubled apostrophes inside quoted long-flag secrets', () => {
  it.each(['--password', '--db-password', '--API-KEY', '--token'])(
    'conceals the full %s value across supported separators',
    (flag) => {
      for (const separator of ['=', ' ', ':', ',']) {
        for (const value of [
          "fixture'' private tail",
          "''fixture private tail",
          "fixture'''' tail''",
        ]) {
          const input = `tool ${flag}${separator}'${value}' --verbose`;
          for (const redact of profiles) {
            const output = redact(input);
            expect(output).toBe(`tool ${flag}${separator}[REDACTED] --verbose`);
            expect(redact(output)).toBe(output);
          }
        }
      }
    },
  );

  it('keeps ordinary quoted values and empty values working', () => {
    for (const quoted of ["'fixture private tail'", '"fixture private tail"', "''", "''''"]) {
      for (const redact of profiles) {
        expect(redact(`tool --password=${quoted} --verbose`)).toBe(
          'tool --password=[REDACTED] --verbose',
        );
      }
    }
  });

  it('does not consume following quoted public arguments', () => {
    const input = "tool --password='fixture'' private tail' --label 'public text'";
    for (const redact of profiles) {
      expect(redact(input)).toBe("tool --password=[REDACTED] --label 'public text'");
    }
  });

  it('leaves non-sensitive flags and ordinary prose unchanged', () => {
    const input = "tool --label='operator''s public text' --verbose";
    for (const redact of profiles) expect(redact(input)).toBe(input);
  });

  it('retains the existing line-bounded behavior for incomplete quoted values', () => {
    for (const redact of profiles) {
      expect(redact("tool --password='fixture\nnext 'line'")).toBe(
        "tool --password=[REDACTED]\nnext 'line'",
      );
    }
  });
});
