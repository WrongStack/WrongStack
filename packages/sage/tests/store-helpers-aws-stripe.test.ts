import { describe, expect, it } from 'vitest';
import { looksLikeSecret } from '../src/store-helpers.js';

/**
 * F87: the sage secret gate (shared by JSONL and SQLite stores) rejects
 * unsafe candidate proposals before the ReviewQueue. Its AWS alternative
 * knew only AKIA — ASIA STS TEMPORARY credentials (identical 20-char shape,
 * the standard SSO/CI federation output) passed the gate and could be
 * persisted into the learning store. Stripe whsec_ webhook signing secrets
 * were likewise absent (only sk/pk/rk live/test keys were covered).
 */
const asiaKey = `ASIA${'Q'.repeat(16)}`;
const akiaKey = `AKIA${'Q'.repeat(16)}`;
const whsec = `whsec_${'a'.repeat(32)}`;

describe('sage secret gate AWS/Stripe coverage (F87)', () => {
  it('rejects an ASIA temporary access key', () => {
    expect(looksLikeSecret(`learned: ${asiaKey}`)).toBe(true);
  });

  it('still rejects AKIA long-term keys (control)', () => {
    expect(looksLikeSecret(akiaKey)).toBe(true);
  });

  it('rejects a whsec_ webhook signing secret', () => {
    expect(looksLikeSecret(`hook secret ${whsec}`)).toBe(true);
  });

  it('still rejects sk_live keys (control)', () => {
    expect(looksLikeSecret(`sk_live_${'b'.repeat(24)}`)).toBe(true);
  });

  it('does not reject a too-short ASIA lookalike (control)', () => {
    expect(looksLikeSecret(`ASIA${'Q'.repeat(15)}`)).toBe(false);
  });

  it('does not reject ordinary learning text (control)', () => {
    expect(looksLikeSecret('the build uses bun workspaces')).toBe(false);
  });
});
