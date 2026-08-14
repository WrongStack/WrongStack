import { describe, expect, it } from 'vitest';
import { LANG_FAMILY_WILDCARD } from '../src/codebase-index/writer-schema.js';
import {
  resolveRefsForNamesUnsafe,
  resolveRefsWithStatement,
} from '../src/codebase-index/writer-refs.js';

type RunStmt = (sql: string) => { run: (...args: (string | number)[]) => unknown };

/**
 * Forces the legacy fallback statements: throws on the modern `UPDATE...FROM`
 * primary so each function's catch branch runs, then asserts that every `?`
 * placeholder in the fallback SQL receives exactly one bind. Regression guard
 * for the FAMILY_MATCH_SQL rewrite (1 placeholder → 2) that left the fallback
 * run() calls with a stale bind count.
 */
function fallbackHarness() {
  const calls: Array<{ sql: string; binds: (string | number)[] }> = [];
  const stmtFn: RunStmt = (sql) => {
    if (sql.includes('SET to_id = s.id')) {
      throw new Error('synthetic: UPDATE...FROM unsupported');
    }
    const placeholders = (sql.match(/\?/g) ?? []).length;
    return {
      run: (...binds: (string | number)[]) => {
        expect(binds.length).toBe(placeholders);
        calls.push({ sql, binds });
        return { changes: 0 };
      },
    };
  };
  return { stmtFn, calls };
}

describe('ref-resolution fallback bind counts', () => {
  it('resolveRefsWithStatement binds both FAMILY_MATCH_SQL placeholders', () => {
    const { stmtFn, calls } = fallbackHarness();
    const result = resolveRefsWithStatement(stmtFn);
    expect(result).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binds).toEqual([LANG_FAMILY_WILDCARD, LANG_FAMILY_WILDCARD]);
  });

  it('resolveRefsForNamesUnsafe binds placeholders in SQL order (family, names, family)', () => {
    const { stmtFn, calls } = fallbackHarness();
    const result = resolveRefsForNamesUnsafe(stmtFn, 999, ['alpha', 'beta', 'gamma']);
    expect(result).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binds).toEqual([
      LANG_FAMILY_WILDCARD,
      'alpha',
      'beta',
      'gamma',
      LANG_FAMILY_WILDCARD,
    ]);
  });
});
