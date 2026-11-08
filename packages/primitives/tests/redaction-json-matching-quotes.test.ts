import { describe, expect, it } from 'vitest';
import { redactCommand, redactCommandArgs, redactSecrets } from '../src/redact-command.js';

const tail = ['private', 'tail'].join('-');

describe('matching quotes in JSON secret fields', () => {
  it.each(['password', 'client_secret', 'accessToken'])(
    'redacts the whole %s string when it contains apostrophes',
    (key) => {
      for (const value of ["'" + tail, "fixture'" + tail, "fixture''" + tail]) {
        const input = JSON.stringify({ [key]: value, count: 3 });
        const expected = `{"${key}":[REDACTED],"count":3}`;
        expect(JSON.parse(input)[key]).toBe(value);
        expect(redactCommand(input)).toBe(expected);
        expect(redactSecrets(input)).toBe(expected);
        expect(redactCommandArgs('curl', ['--data', input]).args).toEqual(['--data', expected]);
        expect(redactCommand(expected)).toBe(expected);
        expect(redactSecrets(expected)).toBe(expected);
      }
    },
  );

  it('handles apostrophes inside shell-escaped double-quoted JSON', () => {
    const input = JSON.stringify({ password: "fixture'" + tail }).replace(/"/g, '\\"');
    const expected = '{\\"password\\":[REDACTED]}';
    expect(redactCommand(input)).toBe(expected);
    expect(redactSecrets(input)).toBe(expected);
  });

  it('keeps the supported single-quoted field form and consumes inner double quotes', () => {
    const input = "{'password':'fixture" + '"' + tail + "','count':3}";
    const expected = "{'password':[REDACTED],'count':3}";
    expect(redactCommand(input)).toBe(expected);
    expect(redactSecrets(input)).toBe(expected);
  });

  it('preserves ordinary fields with apostrophes and the simple secret control', () => {
    const ordinary = JSON.stringify({ name: "fixture'" + tail, count: 3 });
    expect(redactCommand(ordinary)).toBe(ordinary);
    expect(redactSecrets(ordinary)).toBe(ordinary);
    const control = JSON.stringify({ password: ['fixture', 'only'].join('-'), count: 3 });
    expect(redactCommand(control)).toBe('{"password":[REDACTED],"count":3}');
    expect(redactSecrets(control)).toBe('{"password":[REDACTED],"count":3}');
  });
});
