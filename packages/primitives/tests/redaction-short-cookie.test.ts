import { describe, expect, it } from 'vitest';
import { redactCommand, redactCommandArgs, redactSecrets } from '../src/redact-command.js';

const value = ['fixture', 'private', 'cookie'].join('-');
const cookie = 'session=' + value;
const suffix = ' https://localhost/';

describe('curl short cookie option', () => {
  it.each([
    ['-b ' + cookie, '-b [REDACTED]'],
    ['-b' + cookie, '-b[REDACTED]'],
    ['-b "' + cookie + '; theme=dark"', '-b [REDACTED]'],
    ["-b '" + cookie + "; theme=dark'", '-b [REDACTED]'],
  ])('redacts inline cookie data in %s on both text profiles', (option, expected) => {
    const input = 'curl ' + option + suffix;
    expect(redactCommand(input)).toBe('curl ' + expected + suffix);
    expect(redactSecrets(input)).not.toContain(value);
  });

  it('redacts split and attached argv without changing input or array shape', () => {
    for (const args of [['-b', cookie], ['-b' + cookie], ['-b', cookie + '; theme=dark']]) {
      const before = [...args];
      const expected = args.length === 1 ? ['-b[REDACTED]'] : ['-b', '[REDACTED]'];
      const result = redactCommandArgs('curl', args);
      expect(result.args).toEqual(expected);
      expect(args).toEqual(before);
      expect(redactCommandArgs('curl', result.args)).toEqual(result);
    }
  });

  it('does not redact ordinary branch names, cookie filenames, or uppercase -B', () => {
    for (const args of [
      ['checkout', '-b', 'cookie-fix'],
      ['-b', 'cookies.txt'],
      ['-bcookies.txt'],
      ['-B', 'public'],
    ]) {
      const input = 'tool ' + args.join(' ');
      expect(redactCommand(input)).toBe(input);
      expect(redactSecrets(input)).toBe(input);
      expect(redactCommandArgs('tool', args).args).toEqual(args);
    }
  });

  it('keeps the long-cookie control redacted', () => {
    expect(redactCommand('curl --cookie ' + cookie + suffix)).toBe(
      'curl --cookie [REDACTED]' + suffix,
    );
    expect(redactCommandArgs('curl', ['--cookie', cookie]).args).toEqual([
      '--cookie',
      '[REDACTED]',
    ]);
  });
});
