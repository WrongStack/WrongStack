import { describe, expect, it } from 'vitest';
import { analyzeSecurityAndPerformance } from '../src/security-ast-scan-tool.js';

/**
 * F88: the AST security scan's SECRET_PATTERNS knew only AKIA for AWS and
 * only sk_live for Stripe. ASIA STS temporary credentials (identical shape)
 * and whsec_ webhook signing secrets in scanned source went unreported.
 */
function findings(content: string) {
  return analyzeSecurityAndPerformance('src/config.ts', content, { secretsOnly: true });
}
const hasSecret = (content: string) =>
  findings(content).some((f) => f.ruleId === 'sec/hardcoded-secret');

describe('AST scan AWS/Stripe coverage (F88)', () => {
  it('reports an ASIA temporary access key', () => {
    expect(hasSecret(`const key = "ASIA${'Q'.repeat(16)}";`)).toBe(true);
  });

  it('still reports AKIA long-term keys (control)', () => {
    expect(hasSecret(`const key = "AKIA${'Q'.repeat(16)}";`)).toBe(true);
  });

  it('reports a whsec_ webhook signing secret', () => {
    expect(hasSecret(`const secret = "whsec_${'a'.repeat(32)}";`)).toBe(true);
  });

  it('still reports sk_live keys (control)', () => {
    expect(hasSecret(`const key = "sk_live_${'b'.repeat(24)}";`)).toBe(true);
  });

  it('does not report a too-short ASIA lookalike (control)', () => {
    expect(hasSecret(`const s = "ASIA${'Q'.repeat(15)}";`)).toBe(false);
  });
});
