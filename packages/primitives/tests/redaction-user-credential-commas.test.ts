import { describe, expect, it } from 'vitest';
import { redactCommand, redactCommandArgs, redactSecrets } from '../src/redact-command.js';

const suffix = ['fixture', 'private', 'tail'].join('-');
const url = 'https://example.test';

describe('commas inside curl-style user credentials', () => {
  it.each([
    `-u user:first,${suffix}`,
    `-uuser:first,${suffix}`,
    `--user=user:first,${suffix}`,
    `--proxy-user user:first,${suffix}`,
    `--user user,name:first,${suffix}`,
    `--user :first,${suffix}`,
  ])('conceals the complete credential in %s', (credential) => {
    for (const redact of [redactCommand, redactSecrets]) {
      const output = redact(`curl ${credential} ${url}`);
      expect(output).not.toContain(suffix);
      expect(output).toContain(url);
      expect(redact(output)).toBe(output);
    }
  });

  it('keeps surrounding command arguments readable', () => {
    expect(redactCommand(`curl --user user:first,${suffix} ${url}`)).toBe(
      `curl --user [REDACTED] ${url}`,
    );
  });

  it('retains quoted credential handling', () => {
    for (const quote of ['"', "'"]) {
      const input = `curl -u ${quote}user:first,${suffix}${quote} ${url}`;
      expect(redactCommand(input)).not.toContain(suffix);
      expect(redactSecrets(input)).not.toContain(suffix);
    }
  });

  it('preserves argv shape and input for split and attached credentials', () => {
    for (const args of [['--user', `user:first,${suffix}`], [`--user=user:first,${suffix}`]]) {
      const before = [...args];
      const result = redactCommandArgs('curl', args);
      expect(result.args).toHaveLength(args.length);
      expect(result.args.join(' ')).not.toContain(suffix);
      expect(args).toEqual(before);
    }
  });

  it('keeps bare user names and unrelated flags readable', () => {
    for (const input of ['sudo -u user,name ls', `curl --user-agent browser,fixture ${url}`]) {
      expect(redactCommand(input)).toBe(input);
      expect(redactSecrets(input)).toBe(input);
    }
  });
});
