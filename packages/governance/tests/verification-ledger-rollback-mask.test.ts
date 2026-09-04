/**
 * Regression: VerificationLedgerStore transaction guards must preserve the
 * primary error when both COMMIT and ROLLBACK fail.
 *
 * Sibling of the canonical fix in
 * `packages/core/src/session-catalog/store.ts` SessionCatalogStore.transaction
 * (and the kanban SqliteKanbanStorage hardening in
 * `packages/kanban/tests/sqlite-storage-rollback-mask.test.ts`).
 *
 * A failing write (or COMMIT) can end the SQLite transaction, so the
 * follow-up ROLLBACK throws `cannot rollback - no transaction is active`.
 * An unguarded `catch (error) { this.#db.exec('ROLLBACK'); throw error; }`
 * lets that rollback error surface and the primary disk/database error is
 * lost.
 *
 * Static check on the production source — it asserts every catch block that
 * issues `this.#db.exec('ROLLBACK')` wraps that call in `try/catch` (the
 * hardened shape). Since the 2026-09-04 vacuous-detector round the detector
 * is anchored at the block-opening brace — the previous version brace-counted
 * from the catch line itself, so its extracted block was the catch line alone
 * and it could never match anything (it passed vacuously). The detector now
 * self-verifies against embedded guarded and unguarded shapes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = resolve(__dirname, '../src/verification-ledger-store.ts');

interface DetectorResult {
  /** 1-based catch-line numbers whose ROLLBACK call is not try/catch-wrapped. */
  unguarded: number[];
  /** Catch blocks containing a ROLLBACK call (guards against a vacuous pass). */
  rollbackCatchCount: number;
}

function findUnguardedRollbackCatches(source: string): DetectorResult {
  const lines = source.split('\n');
  const unguarded: number[] = [];
  let rollbackCatchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/\}\s*catch\s*\(/.test(lines[i] ?? '')) continue;

    // Anchor at the block-opening '{' after the `catch` keyword and count
    // braces from depth 1. (Counting from the line's leading '}' goes
    // negative and mis-ends on the catch line itself — the trap that made
    // the previous version of this check vacuous.)
    const rest = lines.slice(i).join('\n');
    const catchIdx = rest.indexOf('catch');
    const openIdx = rest.indexOf('{', catchIdx);
    if (openIdx === -1) continue;
    let depth = 0;
    let blockEnd = rest.length - 1;
    for (let k = openIdx; k < rest.length; k++) {
      if (rest[k] === '{') depth++;
      else if (rest[k] === '}') {
        depth--;
        if (depth === 0) {
          blockEnd = k;
          break;
        }
      }
    }

    const block = rest.slice(catchIdx, blockEnd + 1);
    if (!/db\.exec\('ROLLBACK'\)/.test(block)) continue;
    rollbackCatchCount += 1;
    const hasTryCatchWrapper = /try\s*\{[^}]*db\.exec\('ROLLBACK'\)[\s\S]*?\}\s*catch\s*\{/.test(
      block,
    );
    if (!hasTryCatchWrapper) unguarded.push(i + 1);
  }

  return { unguarded, rollbackCatchCount };
}

/** One unguarded and one guarded transaction catch — exactly the two shapes. */
const SAMPLE_SHAPES = [
  'class Store {',
  '  private readonly #db: DatabaseSync;',
  '',
  '  methodOne(): void {',
  "    this.#db.exec('BEGIN IMMEDIATE');",
  '    try {',
  "      this.#db.prepare('INSERT INTO t VALUES (?)').run(1);",
  "      this.#db.exec('COMMIT');",
  '    } catch (error) {',
  "      this.#db.exec('ROLLBACK');",
  '      throw error;',
  '    }',
  '  }',
  '',
  '  methodTwo(): void {',
  "    this.#db.exec('BEGIN IMMEDIATE');",
  '    try {',
  "      this.#db.prepare('INSERT INTO t VALUES (?)').run(2);",
  "      this.#db.exec('COMMIT');",
  '    } catch (error) {',
  '      // SQLite may have already ended the transaction when the write or',
  '      // COMMIT failed; a follow-up ROLLBACK then throws.',
  '      try {',
  "        this.#db.exec('ROLLBACK');",
  '      } catch {',
  '        /* preserve original error */',
  '      }',
  '      throw error;',
  '    }',
  '  }',
  '}',
].join('\n');

describe('VerificationLedgerStore transaction guards', () => {
  it('detects an unguarded catch-block ROLLBACK and skips the guarded shape', () => {
    const result = findUnguardedRollbackCatches(SAMPLE_SHAPES);
    expect(result.rollbackCatchCount).toBe(2);
    expect(result.unguarded).toEqual([9]);
  });

  it('wraps every catch-block ROLLBACK in try/catch (primary-error preservation)', () => {
    const { unguarded, rollbackCatchCount } = findUnguardedRollbackCatches(
      readFileSync(SOURCE, 'utf8'),
    );

    // Guard against a vacuous pass: the store must still own its rollback
    // sites. If the transactions move to another module, update SOURCE.
    expect(rollbackCatchCount).toBeGreaterThan(0);

    expect(
      unguarded,
      `Found ${unguarded.length} unguarded ROLLBACK call(s) in catch blocks at lines: ${unguarded.join(', ')}. ` +
        'These mask the primary SQLite error with the rollback noise. ' +
        'Use the try/catch wrapper from SessionCatalogStore.transaction (packages/core/src/session-catalog/store.ts).',
    ).toEqual([]);
  });
});
