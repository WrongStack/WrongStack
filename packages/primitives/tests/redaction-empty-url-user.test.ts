import { describe, expect, it } from 'vitest';
import { redactCommand, redactCommandArgs, redactSecrets } from '../src/redact-command.js';

const secret = ['fixture', 'private', 'value'].join('-');
const suffix = '@localhost:6379/0';
const url = (scheme: string, user: string, password: string) =>
  scheme + '://' + user + ':' + password + suffix;

// Password-only userinfo is valid (notably for Redis); the username is optional.
describe('URL credentials with an empty username', () => {
  it.each(['redis', 'rediss', 'https'])('redacts %s passwords across all surfaces', (scheme) => {
    const input = url(scheme, '', secret);
    const expected = url(scheme, '', '[REDACTED]');
    expect(new URL(input).password).toBe(secret);
    expect(redactCommand(input)).toBe(expected);
    expect(redactSecrets(input)).toBe(expected);
    expect(redactCommandArgs('curl', ['--url', input]).args).toEqual(['--url', expected]);
  });

  it.each(['x', 'part%40two%3Athree'])('takes the complete password %s', (password) => {
    const input = url('redis', '', password);
    expect(redactCommand(input)).toBe(url('redis', '', '[REDACTED]'));
    expect(redactSecrets(input)).toBe(url('redis', '', '[REDACTED]'));
  });

  it('keeps named-user redaction and repeated redaction stable', () => {
    const input = url('redis', 'alice', secret);
    const expected = url('redis', 'alice', '[REDACTED]');
    expect(redactCommand(input)).toBe(expected);
    expect(redactSecrets(input)).toBe(expected);
    expect(redactCommand(expected)).toBe(expected);
    expect(redactSecrets(expected)).toBe(expected);
  });

  it('does not alter credential-free URLs or empty passwords', () => {
    for (const input of ['https' + '://localhost/a:b', url('redis', '', '')]) {
      expect(redactCommand(input)).toBe(input);
      expect(redactSecrets(input)).toBe(input);
    }
  });
});
