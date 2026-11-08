import { describe, expect, it } from 'vitest';
import { redactCommand, redactCommandArgs, redactSecrets } from '../src/redact-command.js';

const response = 'a1'.repeat(16);
const signature = 'b2'.repeat(32);
const digest =
  'Digest username="fixture", realm="test", nonce="fixture-nonce", response="' + response + '"';
const signed =
  'AWS4-HMAC-SHA256 Credential=fixture/20261109/test/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=' +
  signature;

describe('parameterized Authorization values', () => {
  it.each([
    digest,
    signed,
    'Digest username="fixture\\"user", realm="fixture, realm", response="' + response + '"',
    'Digest username=fixture, response=' + response,
  ])('redacts all parameters in %s across text and argv surfaces', (value) => {
    const header = 'Authorization: ' + value;
    expect(redactCommand(header)).toBe('Authorization:[REDACTED]');
    expect(redactSecrets(header)).toBe('Authorization:[REDACTED]');
    expect(redactCommandArgs('curl', ['-H', header]).args).toEqual([
      '-H',
      'Authorization:[REDACTED]',
    ]);
  });

  it('preserves the surrounding command and headers', () => {
    for (const value of [digest, signed]) {
      const input = "curl -H 'Authorization: " + value + "' https://localhost/";
      expect(redactCommand(input)).toBe("curl -H 'Authorization:[REDACTED]' https://localhost/");
      expect(redactSecrets(input)).toBe("curl -H 'Authorization:[REDACTED]' https://localhost/");
    }
    const input = 'Authorization: ' + digest + '\r\nX-Request-ID: public';
    expect(redactCommand(input)).toBe('Authorization:[REDACTED]\r\nX-Request-ID: public');
  });

  it('keeps Basic, Bearer and already-redacted controls stable', () => {
    const basic = Buffer.from(['fixture-user', 'fixture-pass'].join(':')).toString('base64');
    for (const value of ['Basic ' + basic, 'Bearer ' + response, '[REDACTED]']) {
      const header = 'Authorization: ' + value;
      expect(redactCommand(header)).toBe('Authorization:[REDACTED]');
      expect(redactSecrets(header)).toBe('Authorization:[REDACTED]');
    }
  });

  it('leaves unrelated headers and unlabelled text unchanged', () => {
    for (const input of [
      'Content-Type: application/json',
      'X-Request-ID: public',
      'Digest fixture',
    ]) {
      expect(redactCommand(input)).toBe(input);
      expect(redactSecrets(input)).toBe(input);
    }
  });
});
