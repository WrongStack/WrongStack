/**
 * Regression: SqliteGovernanceEventStore transaction guards must preserve the
 * primary error when both a write and the follow-up ROLLBACK fail.
 *
 * Sibling of the canonical fixes in
 * `packages/core/src/session-catalog/store.ts` SessionCatalogStore.transaction,
 * `packages/kanban/src/server/sqlite-storage.ts`, and
 * `packages/sage/src/sqlite-store-*.ts`: a failing write (or COMMIT) can end
 * the SQLite transaction (SQLITE_FULL/IOERR auto-rollback), so the follow-up
 * ROLLBACK throws `cannot rollback - no transaction is active`. An unguarded
 * `catch (error) { this.db.exec('ROLLBACK'); throw error; }` lets that
 * rollback error surface and the primary disk/database error is lost
 * (execute() and appendObservation() were both affected until the
 * 2026-09-04 governance rollback-mask bug-hunt round).
 *
 * This is a static check on the production source — it asserts every catch
 * block that issues `this.db.exec('ROLLBACK')` wraps that call in `try/catch`
 * (the hardened shape). The dynamic defect shape was proven against the real
 * DatabaseSync transaction lifecycle (real SQLITE_FULL via `PRAGMA
 * max_page_count` pressure through the store's persistence-loader seam) in
 * that round.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = resolve(__dirname, '../src/event-store.ts');

describe('SqliteGovernanceEventStore transaction guards', () => {
  it('wraps every catch-block ROLLBACK in try/catch (primary-error preservation)', () => {
    const lines = readFileSync(SOURCE, 'utf8').split('\n');
    const unguarded: number[] = [];
    let rollbackCatchCount = 0;

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
      const hasTryCatchWrapper = /try\s*\{[^}]*db\.exec\('ROLLBACK'\)[\s\S]*?\}\s*catch\s*\{/.test(
        block,
      );
      if (!hasTryCatchWrapper) unguarded.push(i + 1);
    }

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
