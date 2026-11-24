import { describe, expect, it } from 'vitest';
import { getSecretPatterns } from '../src/skill-patterns.js';

/**
 * F86: the skill security scanner's hardcoded-secrets table knew only AKIA
 * for AWS. ASIA STS temporary credentials (identical shape) and Stripe whsec_
 * webhook signing secrets passed the scan unreported in skill source.
 */
function secretPatterns(): RegExp[] {
  const entry = getSecretPatterns('nodejs').find((p) => p.id === 'hardcoded-secrets');
  if (!entry) throw new Error('hardcoded-secrets pattern missing');
  return entry.patterns;
}

function matchesAny(text: string): boolean {
  return secretPatterns().some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

describe('skill scanner AWS/Stripe coverage (F86)', () => {
  it('reports an ASIA temporary access key', () => {
    expect(matchesAny(`const key = "ASIA${'Q'.repeat(16)}";`)).toBe(true);
  });

  it('still reports AKIA long-term keys (control)', () => {
    expect(matchesAny(`const key = "AKIA${'Q'.repeat(16)}";`)).toBe(true);
  });

  it('reports a whsec_ webhook signing secret', () => {
    expect(matchesAny(`const secret = "whsec_${'a'.repeat(32)}";`)).toBe(true);
  });

  it('does not report a too-short ASIA lookalike (control)', () => {
    expect(matchesAny(`ASIA${'Q'.repeat(15)}`)).toBe(false);
  });
});
