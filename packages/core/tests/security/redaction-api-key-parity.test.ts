import { describe, expect, it } from 'vitest';
import { stripSecretMaterial } from '../../src/storage/cloud-config-sync/sanitize.js';
import { redactHqValue } from '../../src/hq/redaction.js';
import { isSecretField } from '../../src/security/config-secrets.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';

// H-7 (security report VF-08): every spelling of an API-key field name must
// be treated as a secret by ALL THREE layers. The hyphenated forms are the
// literal HTTP header names (`x-api-key` is the Anthropic header); before the
// fix they slipped through BOTH the scrubber's `json_credential_key` pattern
// and the HQ redactor's `isSensitiveKey`, while `config-secrets.ts` already
// flagged them — three layers, three different answers. This suite pins them
// to one answer; if a layer drifts, extend THAT layer, not the test list.
// Values are assembled at runtime so no credential-shaped literal is ever
// committed by this file (secret-scanner hook convention).
const KEY_SPELLINGS = [
  'apiKey',
  'api_key',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-api-key',
];

describe('redaction parity: api[-_]?key across all three layers (H-7 / VF-08)', () => {
  it.each(KEY_SPELLINGS)('config-secrets isSecretField flags "%s"', (key) => {
    expect(isSecretField(key)).toBe(true);
  });

  it.each(KEY_SPELLINGS)('secret-scrubber redacts a JSON credential keyed "%s"', (key) => {
    const value = ['sk-parity-', 'A'.repeat(28)].join('');
    const scrubbed = new DefaultSecretScrubber().scrub(`{"${key}":"${value}"}`);
    expect(scrubbed).not.toContain(value);
  });

  it.each(KEY_SPELLINGS)('hq redaction masks an event field keyed "%s"', (key) => {
    const value = ['sk-parity-', 'B'.repeat(28)].join('');
    const out = redactHqValue({ [key]: value });
    expect(String((out.value as Record<string, unknown>)[key])).not.toContain(value);
  });

  // S2 (F3) — extend the parity test to the fourth redaction layer:
  // cloud-config-sync/sanitize.ts. The previous anchored regex missed
  // every hyphenated spelling, so a `headers` map carrying
  // `x-api-key: sk-…` would be copied to the cloud unchanged.
  it.each(KEY_SPELLINGS)(
    'cloud-config-sync sanitizer strips a "headers" entry keyed "%s"',
    (key) => {
      const value = ['sk-parity-', 'C'.repeat(28)].join('');
      const out = stripSecretMaterial({ headers: { [key]: value } }) as {
        headers: Record<string, string>;
      };
      expect(out.headers[key]).toBeUndefined();
    },
  );
});
