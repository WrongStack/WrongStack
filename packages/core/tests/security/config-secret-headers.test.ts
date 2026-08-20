import { describe, expect, it } from 'vitest';
import { isSecretField } from '../../src/security/config-secrets.js';

/**
 * Regression for the hyphenated-header gap found by the 2026-08-20
 * security-check audit.
 *
 * `apiKey` and `api_key` were recognized; `api-key` — the HTTP header spelling —
 * was not, nor was `Authorization`. `ProviderConfig.headers` and
 * `MCPServerConfig.headers` are a documented place to configure credentials, and
 * the config walker copies unrecognized keys through verbatim. The result was a
 * config that displayed `apiKey: "enc:v1:…"` next to a plaintext bearer token,
 * which is worse than an obviously-unencrypted file: it reads as safe to back
 * up, paste into an issue, or sync.
 */

describe('credential-bearing header names are recognized as secret', () => {
  it.each([
    'Authorization',
    'authorization',
    'Proxy-Authorization',
    'X-Api-Key',
    'api-key',
    'X-Goog-Api-Key',
    'Cookie',
    'refresh-token',
    'session-key',
    'access-token',
    'private-key',
  ])('%s is secret', (name) => {
    expect(isSecretField(name)).toBe(true);
  });

  it.each(['apiKey', 'api_key', 'authToken', 'password', 'client_secret'])(
    'still recognizes the pre-existing spelling %s',
    (name) => {
      expect(isSecretField(name)).toBe(true);
    },
  );
});

describe('ordinary config keys are not misclassified', () => {
  // A false positive here encrypts a benign field and makes the config harder
  // to read and diff, so the negative cases matter as much as the positives.
  it.each([
    'anthropic-version',
    'content-type',
    'accept',
    'baseUrl',
    'model',
    'timeout',
    'keyboard',
    'publicKey',
    'public_key',
    'monkey',
  ])('%s is not secret', (name) => {
    expect(isSecretField(name)).toBe(false);
  });
});
