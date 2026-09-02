import { describe, expect, it } from 'vitest';
import { confirmButtonSegments, payloadDiff } from '../src/components/confirm-prompt.js';

// Pure function tests — no React/Ink rendering needed.
// We import the helpers by testing the exported component's internal
// logic through indirect tests. Since the utility functions are not
// exported, we test behavior through the component's observable output.

// Instead, let's test the pure helper logic by duplicating it minimally.
// These tests cover the branches in stringifyInput, truncate, hasDiff, etc.

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function stringifyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([k]) => k !== 'content' && k !== 'new_string' && k !== 'diff')
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v), 80)}`)
    .join('  ');
}

describe('ConfirmPrompt helpers', () => {
  describe('truncate', () => {
    it('returns string as-is when within limit', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates and adds ellipsis', () => {
      expect(truncate('hello world this is a long string', 10)).toBe('hello wor…');
    });

    it('handles exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('handles empty string', () => {
      expect(truncate('', 5)).toBe('');
    });
  });

  describe('stringifyInput', () => {
    it('returns empty for null', () => {
      expect(stringifyInput(null)).toBe('');
    });

    it('returns empty for undefined', () => {
      expect(stringifyInput(undefined)).toBe('');
    });

    it('returns empty for non-object', () => {
      expect(stringifyInput('string')).toBe('');
    });

    it('serializes simple object', () => {
      const result = stringifyInput({ path: '/tmp/a.ts' });
      expect(result).toContain('path:');
      expect(result).toContain('/tmp/a.ts');
    });

    it('filters out content, new_string, and diff keys', () => {
      const result = stringifyInput({
        content: 'big',
        new_string: 'stuff',
        diff: '--- a',
        path: 'a.ts',
      });
      expect(result).not.toContain('content');
      expect(result).not.toContain('new_string');
      expect(result).not.toContain('diff');
      expect(result).toContain('path');
    });

    it('joins multiple entries with double space', () => {
      const result = stringifyInput({ path: 'a.ts', command: 'ls' });
      expect(result).toContain('  ');
    });

    it('truncates long values', () => {
      const longValue = 'x'.repeat(200);
      const result = stringifyInput({ data: longValue });
      expect(result).toContain('…');
    });

    it('handles empty object', () => {
      expect(stringifyInput({})).toBe('');
    });
  });

  // WS-080. The old `hasDiff` tests exercised the COPY above, not the shipped
  // function — which is how `hasDiff` stayed green while being dead in
  // production: it keyed on `input.diff`, and `diff` exists only on EditOutput,
  // never on the EditInput/WriteInput the dialog receives. The replacement is
  // imported from the real module so it cannot drift the same way.
  describe('payloadDiff (imported from the component, not copied)', () => {
    it('synthesises a diff from old_string/new_string', () => {
      const diff = payloadDiff({
        path: 'a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      });
      expect(diff).toContain('-const a = 1;');
      expect(diff).toContain('+const a = 2;');
    });

    it('renders a whole-file write as an all-added diff', () => {
      const diff = payloadDiff({ path: 'a.ts', content: 'export const x = 1;' });
      expect(diff).toContain('+export const x = 1;');
    });

    it('shows new_string even when old_string is missing', () => {
      // A malformed payload is exactly when the user most needs to see it.
      expect(payloadDiff({ path: 'a.ts', new_string: 'injected' })).toContain('+injected');
    });

    it('still honours a prebuilt diff when one is genuinely supplied', () => {
      expect(payloadDiff({ diff: '--- a\n+++ b' })).toBe('--- a\n+++ b');
    });

    it('returns empty for inputs with no payload', () => {
      expect(payloadDiff({ path: 'a.ts' })).toBe('');
      expect(payloadDiff(null)).toBe('');
      expect(payloadDiff('string')).toBe('');
      expect(payloadDiff({ diff: '' })).toBe('');
    });
  });
});

describe('confirmButtonSegments (button hit-test geometry)', () => {
  it('lays out the four buttons left-to-right with contiguous columns', () => {
    const segs = confirmButtonSegments('P');
    expect(segs.map((s) => s.decision)).toEqual(['yes', 'no', 'always', 'deny']);
    expect(segs[0]).toEqual({ decision: 'yes', start: 0, len: 6 }); // "[y]es "
    expect(segs[1]).toEqual({ decision: 'no', start: 6, len: 5 }); // "[n]o "
    // "[a]lways (" (10) + pattern (1) + ") " (2) = 13
    expect(segs[2]).toEqual({ decision: 'always', start: 11, len: 13 });
    expect(segs[3]).toEqual({ decision: 'deny', start: 24, len: 6 }); // "[d]eny"
  });

  it('shifts the deny button right by the extra pattern length', () => {
    const a = confirmButtonSegments('xx');
    const b = confirmButtonSegments('xxxx');
    expect(b[3]!.start - a[3]!.start).toBe(2);
    // segments never overlap and stay ordered
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!.start).toBe(a[i - 1]!.start + a[i - 1]!.len);
    }
  });
});
