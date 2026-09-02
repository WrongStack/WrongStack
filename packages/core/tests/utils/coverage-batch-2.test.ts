import { describe, it, expect } from 'vitest';
import { compileGlob, matchGlob, matchAny } from '../../src/utils/glob-match.js';
import { detectNewlineStyle, toStyle, normalizeToLf } from '../../src/utils/newline-normalize.js';
import {
  safeParse,
  safeStringify,
  sanitizeJsonString,
  stripCodeFences,
} from '../../src/utils/safe-json.js';
import { deepMerge, isPrimitiveArray, FORBIDDEN_PROTO_KEYS } from '../../src/utils/deep-merge.js';

// ── glob-match ─────────────────────────────────────────────────────────

describe('compileGlob', () => {
  it('compiles a literal pattern', () => {
    const re = compileGlob('exact');
    expect(re.test('exact')).toBe(true);
    expect(re.test('other')).toBe(false);
  });

  it('compiles * (single-level wildcard)', () => {
    const re = compileGlob('foo/*.ts');
    expect(re.test('foo/a.ts')).toBe(true);
    expect(re.test('foo/sub/a.ts')).toBe(false); // * doesn't cross /
  });

  it('compiles ** (multi-level wildcard)', () => {
    const re = compileGlob('**/*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/sub/a.ts')).toBe(true);
  });

  it('compiles ? (single char)', () => {
    const re = compileGlob('?.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('ab.ts')).toBe(false);
  });

  it('compiles character classes', () => {
    const re = compileGlob('[abc].ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('b.ts')).toBe(true);
    expect(re.test('d.ts')).toBe(false);
  });

  it('compiles negated character classes', () => {
    const re = compileGlob('[!abc].ts');
    expect(re.test('a.ts')).toBe(false);
    expect(re.test('d.ts')).toBe(true);
  });

  it('compiles ranges', () => {
    const re = compileGlob('[0-9].ts');
    expect(re.test('5.ts')).toBe(true);
    expect(re.test('a.ts')).toBe(false);
  });

  it('throws on patterns exceeding max length', () => {
    expect(() => compileGlob('a'.repeat(1025))).toThrow('exceeds');
  });
});

describe('matchGlob', () => {
  it('matches with cache (repeated calls)', () => {
    expect(matchGlob('*.ts', 'a.ts')).toBe(true);
    expect(matchGlob('*.ts', 'a.ts')).toBe(true); // cached
    expect(matchGlob('*.ts', 'a.js')).toBe(false);
  });

  it('matches **/ pattern', () => {
    expect(matchGlob('**/test', 'a/b/test')).toBe(true);
    expect(matchGlob('**/test', 'test')).toBe(true);
  });
});

describe('matchAny', () => {
  it('returns true if any pattern matches', () => {
    expect(matchAny(['*.ts', '*.js'], 'a.ts')).toBe(true);
    expect(matchAny(['*.ts', '*.js'], 'a.js')).toBe(true);
    expect(matchAny(['*.ts', '*.js'], 'a.py')).toBe(false);
  });

  it('returns false for empty patterns', () => {
    expect(matchAny([], 'anything')).toBe(false);
  });
});

// ── newline-normalize ──────────────────────────────────────────────────

describe('detectNewlineStyle', () => {
  it('detects LF', () => {
    expect(detectNewlineStyle('line1\nline2\n')).toBe('lf');
  });

  it('detects CRLF', () => {
    expect(detectNewlineStyle('line1\r\nline2\r\n')).toBe('crlf');
  });

  it('detects CR', () => {
    expect(detectNewlineStyle('line1\rline2\r')).toBe('cr');
  });

  it('defaults to LF when no newlines', () => {
    expect(detectNewlineStyle('no newlines')).toBe('lf');
  });

  it('detects mixed (majority wins)', () => {
    expect(detectNewlineStyle('a\nb\r\nc\r\nd\r\n')).toBe('crlf');
  });
});

describe('toStyle', () => {
  it('converts to LF', () => {
    expect(toStyle('a\r\nb\rc', 'lf')).toBe('a\nb\nc');
  });

  it('converts to CRLF', () => {
    expect(toStyle('a\nb\nc', 'crlf')).toBe('a\r\nb\r\nc');
  });

  it('converts to CR', () => {
    expect(toStyle('a\nb\nc', 'cr')).toBe('a\rb\rc');
  });
});

describe('normalizeToLf', () => {
  it('normalizes CRLF', () => {
    expect(normalizeToLf('a\r\nb')).toBe('a\nb');
  });

  it('normalizes bare CR', () => {
    expect(normalizeToLf('a\rb')).toBe('a\nb');
  });

  it('preserves LF', () => {
    expect(normalizeToLf('a\nb')).toBe('a\nb');
  });
});

// ── safe-json ──────────────────────────────────────────────────────────

describe('safeParse', () => {
  it('parses valid JSON', () => {
    const r = safeParse('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('returns error for invalid JSON', () => {
    const r = safeParse('{bad}');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('rejects input exceeding size limit', () => {
    const r = safeParse('x'.repeat(100), 50);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('exceeds');
  });
});

describe('safeStringify', () => {
  it('stringifies plain objects', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('stringifies BigInt as string', () => {
    expect(safeStringify({ n: 123n })).toContain('"123"');
  });

  it('stringifies Error objects', () => {
    const result = safeStringify(new Error('test'));
    expect(result).toContain('test');
    expect(result).toContain('message');
  });

  it('handles circular references', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const result = safeStringify(obj);
    expect(result).toContain('[Circular]');
  });

  it('supports pretty printing', () => {
    const result = safeStringify({ a: 1 }, true);
    expect(result).toContain('\n');
  });
});

describe('sanitizeJsonString', () => {
  it('strips trailing commas', () => {
    const r = sanitizeJsonString('{"a":1,}');
    expect(r).toBe('{"a":1}');
  });

  it('strips single-line comments outside strings', () => {
    const r = sanitizeJsonString('{\n// comment\n"a":1\n}');
    expect(r).toContain('"a"');
    expect(r).not.toContain('comment');
  });

  it('escapes literal control characters inside strings', () => {
    const input = '{"text":"line1\nline2"}';
    const r = sanitizeJsonString(input);
    expect(r).toContain('\\n');
  });

  it('returns null for unrecoverable input', () => {
    expect(sanitizeJsonString('completely invalid')).toBeNull();
  });

  it('preserves already-valid JSON', () => {
    expect(sanitizeJsonString('{"a":1}')).toBe('{"a":1}');
  });
});

describe('stripCodeFences', () => {
  it('strips whole-payload fence', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips fence without closer (truncated)', () => {
    expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
  });

  it('extracts embedded fenced block from prose', () => {
    const input = 'Here is the result:\n```json\n{"a":1}\n```\nDone.';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it('returns null when no fence present', () => {
    expect(stripCodeFences('{"a":1}')).toBeNull();
  });
});

// ── deep-merge ─────────────────────────────────────────────────────────

describe('isPrimitiveArray', () => {
  it('returns true for all-primitive arrays', () => {
    expect(isPrimitiveArray([1, 'x', null, true])).toBe(true);
  });

  it('returns false for arrays containing objects', () => {
    expect(isPrimitiveArray([1, { a: 1 }])).toBe(false);
  });

  it('returns true for empty array', () => {
    expect(isPrimitiveArray([])).toBe(true);
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const result = deepMerge({ a: { b: 1 } }, { a: { c: 2 } });
    expect(result).toEqual({ a: { b: 1, c: 2 } });
  });

  it('patch overrides base by default (prefer-patch)', () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it('prefer-base preserves base for top-level non-object patch', () => {
    // prefer-base only applies at the top level when one side is non-object
    const result = deepMerge({ a: 1 }, 'replacement', { conflictResolution: 'prefer-base' });
    expect(result).toEqual({ a: 1 });
  });

  it('replaces arrays by default', () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [3, 4] });
    expect(result).toEqual({ arr: [3, 4] });
  });

  it('concatenates primitive arrays with concat-primitives mode', () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [2, 3] }, { arrayMode: 'concat-primitives' });
    expect(result).toEqual({ arr: [1, 2, 3] }); // deduped via Set
  });

  it('skips forbidden proto keys by default', () => {
    // __proto__ in a plain object literal is consumed by JS as the prototype,
    // so it never appears as an own enumerable key. Test with 'constructor'
    // instead, which is a real forbidden key.
    const result = deepMerge({ a: 1 }, { constructor: { x: 1 }, a: 2 } as Record<string, unknown>);
    expect(result).toEqual({ a: 2 });
    expect((result as Record<string, unknown>).constructor).toBe(Object); // not the patched one
  });

  it('allows undefined to preserve existing value', () => {
    const result = deepMerge({ a: 1 }, { a: undefined });
    expect(result).toEqual({ a: 1 });
  });

  it('handles null patch value (replaces with prefer-patch)', () => {
    const result = deepMerge({ a: 1 }, { a: null });
    expect(result).toEqual({ a: null });
  });

  it('handles null patch value at top level (preserves with prefer-base)', () => {
    // prefer-base at the top level: base is non-null object, patch is null → base wins
    const result = deepMerge({ a: 1 }, null, { conflictResolution: 'prefer-base' });
    expect(result).toEqual({ a: 1 });
  });

  it('preserves base keys absent from patch', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3 });
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('fires onNonPrimitiveArrayReplace callback', () => {
    let called = false;
    deepMerge(
      { arr: [1] },
      { arr: [{ x: 1 }] },
      {
        arrayMode: 'concat-primitives',
        onNonPrimitiveArrayReplace: () => {
          called = true;
        },
      },
    );
    expect(called).toBe(true);
  });

  it('handles non-object base (returns patch with prefer-patch)', () => {
    expect(deepMerge(42, { a: 1 })).toEqual({ a: 1 });
  });

  it('handles non-object patch (returns patch with prefer-patch)', () => {
    expect(deepMerge({ a: 1 }, 'string')).toBe('string');
  });
});

describe('FORBIDDEN_PROTO_KEYS', () => {
  it('contains __proto__ and constructor', () => {
    expect(FORBIDDEN_PROTO_KEYS.has('__proto__')).toBe(true);
    expect(FORBIDDEN_PROTO_KEYS.has('constructor')).toBe(true);
    expect(FORBIDDEN_PROTO_KEYS.has('prototype')).toBe(true);
  });
});
