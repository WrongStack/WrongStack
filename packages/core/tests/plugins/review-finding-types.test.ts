/**
 * Tests for Chimera Finding Store types, fingerprint, and error classes.
 *
 * FS-P0.0
 */
import { describe, expect, it } from 'vitest';
import {
  computeFindingFingerprint,
  FindingNotFoundError,
  InvalidTransitionError,
  normalizeFingerprintTitle,
  validateTransition,
  type FindingStatus,
} from '../../src/plugins/review-finding-types.js';

// ── Fingerprint ────────────────────────────────────────────────────

describe('computeFindingFingerprint', () => {
  it('produces a deterministic 64-char hex string', () => {
    const fp = computeFindingFingerprint('src/app.ts', 42, 'Null dereference');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = computeFindingFingerprint('src/app.ts', 42, 'Null dereference');
    const b = computeFindingFingerprint('src/app.ts', 42, 'Null dereference');
    expect(a).toBe(b);
  });

  it('changes when the file changes', () => {
    const a = computeFindingFingerprint('src/a.ts', 1, 'title');
    const b = computeFindingFingerprint('src/b.ts', 1, 'title');
    expect(a).not.toBe(b);
  });

  it('changes when the line changes', () => {
    const a = computeFindingFingerprint('f.ts', 10, 't');
    const b = computeFindingFingerprint('f.ts', 20, 't');
    expect(a).not.toBe(b);
  });

  it('changes when the title changes', () => {
    const a = computeFindingFingerprint('f.ts', 1, 'Issue one');
    const b = computeFindingFingerprint('f.ts', 1, 'Issue two');
    expect(a).not.toBe(b);
  });

  it('normalizes the title before hashing', () => {
    const a = computeFindingFingerprint('f.ts', 1, 'Null Dereference!');
    const b = computeFindingFingerprint('f.ts', 1, 'Null dereference');
    expect(a).toBe(b);
  });

  it('normalizes file paths (backslash to forward slash)', () => {
    const a = computeFindingFingerprint('src\\app.ts', 42, 'X');
    const b = computeFindingFingerprint('src/app.ts', 42, 'X');
    expect(a).toBe(b);
  });

  it('handles null line as 0', () => {
    const a = computeFindingFingerprint('f.ts', null, 'T');
    const b = computeFindingFingerprint('f.ts', 0, 'T');
    expect(a).toBe(b);
  });

  it('handles undefined line as 0', () => {
    const a = computeFindingFingerprint('f.ts', undefined, 'T');
    const b = computeFindingFingerprint('f.ts', 0, 'T');
    expect(a).toBe(b);
  });

  it('handles negative line as 0', () => {
    const a = computeFindingFingerprint('f.ts', -1, 'T');
    const b = computeFindingFingerprint('f.ts', 0, 'T');
    expect(a).toBe(b);
  });

  it('handles unicode in title', () => {
    const fp = computeFindingFingerprint('f.ts', 1, 'Unicode — test ✓');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles multi-line title by normalizing whitespace', () => {
    const a = computeFindingFingerprint('f.ts', 1, 'Line1\nLine2');
    const b = computeFindingFingerprint('f.ts', 1, 'Line1  Line2');
    expect(a).toBe(b);
  });
});

describe('normalizeFingerprintTitle', () => {
  it('lowercases the title', () => {
    expect(normalizeFingerprintTitle('HELLO')).toBe('hello');
  });

  it('strips trailing punctuation', () => {
    expect(normalizeFingerprintTitle('Fix it!')).toBe('fix it');
    expect(normalizeFingerprintTitle('Serious bug.')).toBe('serious bug');
    expect(normalizeFingerprintTitle('What?')).toBe('what');
  });

  it('collapses whitespace', () => {
    expect(normalizeFingerprintTitle('a   b    c')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeFingerprintTitle('  hello  ')).toBe('hello');
  });

  it('keeps alphanumeric and underscores', () => {
    expect(normalizeFingerprintTitle('null_deref in User.find()')).toBe('null_deref in userfind');
  });

  it('handles empty string', () => {
    expect(normalizeFingerprintTitle('')).toBe('');
  });
});

// ── Transition validation ──────────────────────────────────────────

describe('validateTransition', () => {
  const transitions: Array<{ from: FindingStatus; to: FindingStatus; valid: boolean }> = [
    // found → *
    { from: 'active', to: 'triaged', valid: true },
    { from: 'active', to: 'ignored', valid: true },
    { from: 'active', to: 'resolved', valid: true },
    { from: 'active', to: 'in_progress', valid: false },
    { from: 'active', to: 'active', valid: true }, // idempotent
    // triaged → *
    { from: 'triaged', to: 'in_progress', valid: true },
    { from: 'triaged', to: 'ignored', valid: true },
    { from: 'triaged', to: 'resolved', valid: true },
    { from: 'triaged', to: 'active', valid: false },
    // in_progress → *
    { from: 'in_progress', to: 'resolved', valid: true },
    { from: 'in_progress', to: 'active', valid: true },
    { from: 'in_progress', to: 'ignored', valid: false },
    // ignored → *
    { from: 'ignored', to: 'active', valid: true },
    { from: 'ignored', to: 'resolved', valid: false },
    // resolved → *
    { from: 'resolved', to: 'active', valid: true },
    { from: 'resolved', to: 'ignored', valid: false },
  ];

  for (const { from, to, valid } of transitions) {
    it(`${from} → ${to} is ${valid ? 'valid' : 'invalid'}`, () => {
      if (valid) {
        expect(() => validateTransition(from, to)).not.toThrow();
      } else {
        expect(() => validateTransition(from, to)).toThrow(InvalidTransitionError);
      }
    });
  }
});

// ── Error classes ──────────────────────────────────────────────────

describe('FindingNotFoundError', () => {
  it('has the correct name and message', () => {
    const err = new FindingNotFoundError('abc-123');
    expect(err.name).toBe('FindingNotFoundError');
    expect(err.message).toContain('abc-123');
    expect(err.findingId).toBe('abc-123');
  });
});
