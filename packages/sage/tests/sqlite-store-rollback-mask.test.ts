/**
 * Regression: sage SQLite store transaction guards must preserve the primary
 * error when a statement or COMMIT fails inside BEGIN/COMMIT.
 *
 * Sibling of the canonical fixes in
 * `packages/core/src/session-catalog/store.ts` (SessionCatalogStore.transaction)
 * and `packages/kanban/src/server/sqlite-storage.ts`: a failing write (or
 * COMMIT) can end the SQLite transaction (SQLITE_FULL/IOERR auto-rollback),
 * so the follow-up ROLLBACK throws `cannot rollback - no transaction is
 * active`. An unguarded `catch (err) { db.exec('ROLLBACK'); throw err; }`
 * lets that rollback error surface and the primary disk/database error is
 * lost.
 *
 * This is a static check on the production source — it asserts every catch
 * block that issues `db.exec('ROLLBACK')` wraps that call in `try/catch`
 * (the hardened shape). The dynamic defect shape was proven against the real
 * DatabaseSync transaction lifecycle (FTS backfill under
 * `PRAGMA max_page_count` pressure) in the 2026-09-04 sage rollback-mask
 * bug-hunt round.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  resolve(__dirname, '../src/sqlite-store-schema.ts'),
  resolve(__dirname, '../src/sqlite-store-initialize.ts'),
  resolve(__dirname, '../src/sqlite-store-jsonl-migration.ts'),
] as const;

describe('sage sqlite store transaction guards', () => {
  it('wraps every catch-block ROLLBACK in try/catch (primary-error preservation)', () => {
    const unguarded: string[] = [];
    let rollbackCatchCount = 0;

    for (const source of SOURCES) {
      const lines = readFileSync(source, 'utf8').split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (!/\}\s*catch\s*\(/.test(lines[i] ?? '')) continue;

        // Extract the catch block: anchor at the block-opening '{' after the
        // `catch` keyword and count braces from depth 1. (Counting from the
        // line's leading '}' goes negative and mis-ends on the catch line
        // itself — the trap that makes naive versions of this check vacuous.)
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
        const hasTryCatchWrapper =
          /try\s*\{[^}]*db\.exec\('ROLLBACK'\)[\s\S]*?\}\s*catch\s*\{/.test(block);
        if (!hasTryCatchWrapper) unguarded.push(`${source}:${i + 1}`);
      }
    }

    // Guard against a vacuous pass: the stores must still own their rollback
    // sites. If a store moves or drops its transactions, update SOURCES.
    expect(rollbackCatchCount).toBeGreaterThan(0);

    expect(
      unguarded,
      `Found ${unguarded.length} unguarded ROLLBACK call(s) in catch blocks at: ${unguarded.join(', ')}. ` +
        'These mask the primary SQLite error with rollback noise. ' +
        'Wrap the ROLLBACK in try/catch (see SessionCatalogStore.transaction in packages/core/src/session-catalog/store.ts).',
    ).toEqual([]);
  });
});
