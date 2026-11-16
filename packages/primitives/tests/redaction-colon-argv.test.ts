import { describe, expect, it } from 'vitest';
import { redactCommandArgs } from '../src/redact-command.js';

describe('colon-attached sensitive argv values', () => {
  it.each(['--password', '--db-password', '--API-KEY', '--token'])(
    'conceals the complete %s value, including whitespace',
    (flag) => {
      for (const value of [
        'fixture private tail',
        'fixture\tprivate tail',
        'fixture\nprivate tail',
        'fixture=part,second:part private tail',
      ]) {
        const args = [`${flag}:${value}`, '--verbose', 'public space'];
        const before = [...args];
        const result = redactCommandArgs('tool', args);
        expect(result).toEqual({
          command: 'tool',
          args: [`${flag}:[REDACTED]`, '--verbose', 'public space'],
        });
        expect(args).toEqual(before);
        expect(redactCommandArgs(result.command, result.args)).toEqual(result);
      }
    },
  );

  it.each(['=', ','])('preserves complete-value handling for the %s separator', (separator) => {
    expect(redactCommandArgs('tool', [`--password${separator}fixture private tail`])).toEqual({
      command: 'tool',
      args: [`--password${separator}[REDACTED]`],
    });
  });

  it('handles empty colon values without consuming the next argument', () => {
    expect(redactCommandArgs('tool', ['--password:', 'public space']).args).toEqual([
      '--password:[REDACTED]',
      'public space',
    ]);
  });

  it('leaves non-sensitive names, bare flags, and unrelated colons readable', () => {
    const args = ['--token-file:public path', '--format:public text', 'C:\\public path', '--token'];
    expect(redactCommandArgs('tool', args)).toEqual({ command: 'tool', args });
  });
});
