/**
 * Tests for EvidenceValidator — enforced "proof, not opinion" contract.
 *
 * Coverage targets:
 * - constructor accepts partial rules or uses defaults
 * - setRule overwrites specific rule keys
 * - validate rejects bare verdicts without backing refs
 * - validate accepts verdicts with sufficient concrete references
 * - validate checks minimum ref count
 * - validate rejects vague summaries
 * - validate checks required reference kinds
 */
import { describe, expect, it } from 'vitest';
import { EvidenceValidator } from '../../src/verification/evidence-validator.js';
import type { KanbanVerificationCheckResult } from '../../src/types.js';

function makeResult(
  overrides: Partial<KanbanVerificationCheckResult> = {},
): KanbanVerificationCheckResult {
  return {
    checkId: 'check-1',
    checkType: 'council',
    status: 'passed',
    description: 'Verify implementation',
    backingRefs: [],
    evidence: {},
    ...overrides,
  } as KanbanVerificationCheckResult;
}

describe('EvidenceValidator', () => {
  describe('constructor', () => {
    it('creates an instance with default rules', () => {
      const v = new EvidenceValidator();
      expect(v).toBeDefined();
    });

    it('accepts partial rules override', () => {
      const v = new EvidenceValidator({ minRefs: 3, rejectBareVerdict: false });
      expect(v).toBeDefined();
    });
  });

  describe('setRule', () => {
    it('overwrites a specific rule key', () => {
      const v = new EvidenceValidator();
      v.setRule('minRefs', 3);

      const result = v.validate(makeResult());
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('3'))).toBe(true);
    });
  });

  describe('validate', () => {
    it('rejects a bare verdict without backing refs', () => {
      const v = new EvidenceValidator();
      const result = v.validate(makeResult({ backingRefs: [] }));
      expect(result.valid).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('accepts a verdict with sufficient concrete references', () => {
      const v = new EvidenceValidator();
      const result = v.validate(
        makeResult({
          backingRefs: [
            { kind: 'file', path: 'src/test.ts', summary: 'Added login handler (47 lines)' },
            { kind: 'test', path: 'test/login.test.ts', summary: '16 tests, all passing' },
          ],
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('rejects when ref count is below minRefs', () => {
      const v = new EvidenceValidator({ minRefs: 3 });
      const result = v.validate(
        makeResult({
          backingRefs: [{ kind: 'file', path: 'src/test.ts', summary: 'Changed something' }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('3'))).toBe(true);
    });

    it('rejects vague summaries', () => {
      const v = new EvidenceValidator();
      const result = v.validate(
        makeResult({
          backingRefs: [{ kind: 'file', path: 'src/test.ts', summary: 'passed' }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('vague') || r.includes('Vague'))).toBe(true);
    });

    it('rejects missing required reference kinds', () => {
      const v = new EvidenceValidator({
        requiredRefKinds: ['file', 'diff'],
      });
      const result = v.validate(
        makeResult({
          backingRefs: [{ kind: 'file', path: 'src/test.ts', summary: 'Added 3 files' }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('diff'))).toBe(true);
    });

    it('passes when all required kinds are present', () => {
      const v = new EvidenceValidator({
        requiredRefKinds: ['file', 'test'],
      });
      const result = v.validate(
        makeResult({
          backingRefs: [
            { kind: 'file', path: 'src/main.ts', summary: 'Refactored core logic' },
            { kind: 'test', path: 'test/main.test.ts', summary: 'Updated 22 tests' },
          ],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('accepts when rejectBareVerdict is false even with empty refs', () => {
      const v = new EvidenceValidator({ rejectBareVerdict: false, minRefs: 0 });
      const result = v.validate(makeResult({ backingRefs: [] }));
      expect(result.valid).toBe(true);
    });
  });
});
