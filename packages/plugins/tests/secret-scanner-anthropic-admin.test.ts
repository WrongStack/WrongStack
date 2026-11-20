import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { detectSecrets } from '../src/prompt-firewall/index.js';
import { findMatches, redactString } from '../src/secret-scanner/secret-scanner-redaction.js';

/**
 * F19: Anthropic Admin API keys (`sk-ant-admin01-…`) grant organization-
 * management access — broader than a regular api-series key. The anthropic_key
 * pattern recognized only `sk-ant-api\d+-…`, and openai_key excludes every
 * `sk-ant-` via (?!ant), so admin keys fell into the hole between the two:
 * invisible to secret-scanner (the default-ACTIVE block/redact gate) and
 * prompt-firewall (the outgoing-request gate). The core scrubber's broader
 * openai pattern happened to redact them, mislabeled — a parity drift the
 * SHARED_CORPUS now guards (credential-pattern-parity.test.ts). Both lists
 * accept `(?:api|admin)\d+` series.
 */
const ADMIN = 'sk-ant-admin01-ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl';
const API = 'sk-ant-api03-ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl';

describe('Anthropic admin keys are detected on every surface (F19)', () => {
  it('the scanner detects bare and header-carried admin keys', () => {
    expect(findMatches(ADMIN)).toContain('anthropic_key');
    const cmd = `curl -H "x-api-key: ${ADMIN}" https://api.anthropic.com/v1/organizations`;
    expect(findMatches(cmd)).toContain('anthropic_key');
  });

  it('prompt-firewall detects the admin key (legacy kind name)', () => {
    const found = detectSecrets(`context: ${ADMIN}`, []);
    expect(found.map((d) => d.kind)).toContain('anthropic-key');
  });

  it('the core scrubber redacts with the correct label (parity)', () => {
    const scrubber = new DefaultSecretScrubber();
    expect(scrubber.scrub(ADMIN)).toBe('[REDACTED:anthropic_key]');
    expect(scrubber.scrub(API)).toBe('[REDACTED:anthropic_key]');
  });

  it('scanner redact mode replaces the admin key', () => {
    const r = redactString(`token=${ADMIN};`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('token=[REDACTED:anthropic_key];');
  });

  it('api-series keys keep their detection on every surface', () => {
    expect(findMatches(API)).toContain('anthropic_key');
    expect(detectSecrets(API, []).map((d) => d.kind)).toContain('anthropic-key');
    expect(new DefaultSecretScrubber().scrub(API)).not.toBe(API);
  });

  it('keyed admin shapes are detected by the specific pattern', () => {
    expect(findMatches(`ANTHROPIC_ADMIN_KEY=${ADMIN}`)).toContain('anthropic_key');
    expect(findMatches(`{"apiKey": "${ADMIN}"}`)).toContain('anthropic_key');
  });

  it('precision: boundaries and non-credential text stay undetected', () => {
    expect(findMatches('sk-ant-admin01-short')).toHaveLength(0);
    expect(findMatches('the sk-ant-admin01- prefix is documented')).toHaveLength(0);
    // admin-series requires digits (admin01, admin02…); prose variants are not keys.
    expect(findMatches(`sk-ant-adminXX-${'a'.repeat(30)}`)).toHaveLength(0);
    expect(findMatches('DEBUG=true')).toHaveLength(0);
    expect(findMatches('NODE_ENV=production')).toHaveLength(0);
  });

  it('firewall allow list still honoured for admin keys', () => {
    const found = detectSecrets(ADMIN, [new RegExp(ADMIN)]);
    expect(found.map((d) => d.kind)).not.toContain('anthropic-key');
  });

  it('future admin series numbers are covered', () => {
    expect(findMatches(`sk-ant-admin02-${'b'.repeat(30)}`)).toContain('anthropic_key');
  });
});
