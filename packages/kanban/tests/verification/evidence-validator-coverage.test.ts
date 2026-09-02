/**
 * Coverage for kanban/src/verification/evidence-validator.ts
 */
import { describe, expect, it } from 'vitest';
import {
  EvidenceValidator,
  DEFAULT_EVIDENCE_RULES,
} from '../../src/verification/evidence-validator.js';
import type { KanbanVerificationCheckResult } from '../../src/types.js';

function makeResult(
  overrides: Partial<KanbanVerificationCheckResult> = {},
): KanbanVerificationCheckResult {
  return {
    checkId: 'check-1',
    description: 'test',
    type: 'agent',
    status: 'passed',
    evidence: {},
    ...overrides,
  } as KanbanVerificationCheckResult;
}

describe('EvidenceValidator', () => {
  it('uses default rules when none provided', () => {
    const ev = new EvidenceValidator();
    expect(ev).toBeDefined();
  });

  it('rejects bare verdict with no backing refs', () => {
    const ev = new EvidenceValidator();
    const result = ev.validate(makeResult());
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('No concrete'))).toBe(true);
  });

  it('accepts result with sufficient backing refs', () => {
    const ev = new EvidenceValidator();
    const result = ev.validate(
      makeResult({
        backingRefs: [
          {
            kind: 'file',
            path: 'src/foo.ts',
            summary: 'Added login handler at src/routes/login.ts',
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('rejects vague summaries', () => {
    const ev = new EvidenceValidator();
    const result = ev.validate(
      makeResult({
        backingRefs: [{ kind: 'file', path: 'src/foo.ts', summary: 'passed' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Vague'))).toBe(true);
  });

  it('rejects very short summaries', () => {
    const ev = new EvidenceValidator();
    const result = ev.validate(
      makeResult({
        backingRefs: [{ kind: 'file', path: 'src/foo.ts', summary: 'ok' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Vague'))).toBe(true);
  });

  it('accepts descriptive summaries', () => {
    const ev = new EvidenceValidator();
    const result = ev.validate(
      makeResult({
        backingRefs: [
          {
            kind: 'test',
            path: 'tests/login.test.ts',
            summary: 'Added 15 unit tests for login flow',
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('enforces minRefs rule', () => {
    const ev = new EvidenceValidator({ minRefs: 3, rejectBareVerdict: false });
    const result = ev.validate(
      makeResult({
        backingRefs: [
          { kind: 'file', path: 'a.ts', summary: 'changed file a' },
          { kind: 'file', path: 'b.ts', summary: 'changed file b' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Expected at least 3'))).toBe(true);
  });

  it('enforces requiredRefKinds rule', () => {
    const ev = new EvidenceValidator({
      rejectBareVerdict: false,
      requiredRefKinds: ['test'],
    });
    const result = ev.validate(
      makeResult({
        backingRefs: [{ kind: 'file', path: 'a.ts', summary: 'changed file a' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Missing required evidence kinds'))).toBe(true);
  });

  it('passes when requiredRefKinds are satisfied', () => {
    const ev = new EvidenceValidator({
      rejectBareVerdict: false,
      requiredRefKinds: ['file'],
    });
    const result = ev.validate(
      makeResult({
        backingRefs: [{ kind: 'file', path: 'a.ts', summary: 'changed file a substantially' }],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('setRule updates a rule', () => {
    const ev = new EvidenceValidator();
    ev.setRule('minRefs', 5);
    ev.setRule('rejectBareVerdict', false);
    const result = ev.validate(makeResult());
    expect(result.reasons.some((r) => r.includes('Expected at least 5'))).toBe(true);
  });

  it('rejectBareVerdict=false allows no refs', () => {
    const ev = new EvidenceValidator({ rejectBareVerdict: false, minRefs: 0 });
    const result = ev.validate(makeResult());
    expect(result.valid).toBe(true);
  });

  it('handles empty backingRefs array', () => {
    const ev = new EvidenceValidator({ rejectBareVerdict: false, minRefs: 0 });
    const result = ev.validate(makeResult({ backingRefs: [] }));
    expect(result.valid).toBe(true);
  });

  it('accepts multiple refs with varying kinds', () => {
    const ev = new EvidenceValidator({
      rejectBareVerdict: false,
      requiredRefKinds: ['file', 'test'],
    });
    const result = ev.validate(
      makeResult({
        backingRefs: [
          { kind: 'file', path: 'a.ts', summary: 'modified file a significantly' },
          { kind: 'test', path: 'a.test.ts', summary: 'added comprehensive test suite' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects all refs that have vague summaries', () => {
    const ev = new EvidenceValidator({ rejectBareVerdict: false });
    const result = ev.validate(
      makeResult({
        backingRefs: [
          { kind: 'file', path: 'a.ts', summary: 'done' },
          { kind: 'file', path: 'b.ts', summary: 'ok' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.filter((r) => r.includes('Vague')).length).toBe(2);
  });

  it('DEFAULT_EVIDENCE_RULES has correct defaults', () => {
    expect(DEFAULT_EVIDENCE_RULES.minRefs).toBe(1);
    expect(DEFAULT_EVIDENCE_RULES.rejectBareVerdict).toBe(true);
    expect(DEFAULT_EVIDENCE_RULES.rejectVagueSummary).toBe(true);
  });
});
