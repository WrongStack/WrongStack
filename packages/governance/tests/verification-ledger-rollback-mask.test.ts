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
 * An unguarded `catch (error) { db.exec('ROLLBACK'); throw error; }` lets
 * that rollback error surface and the primary disk/database error is lost.
 *
 * This is a static check on the production source — it asserts every
 * `catch (error)` block that issues `this.#db.exec('ROLLBACK')` wraps that
 * call in `try/catch` (the hardened shape). A companion replica-based
 * proof in `.temp_files/elite-bug-hunter/round-002/` exercises the real
 * DatabaseSync transaction lifecycle to demonstrate the defect shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = resolve(__dirname, '../src/verification-ledger-store.ts');

describe('VerificationLedgerStore transaction guards', () => {
  it('wraps every catch-block ROLLBACK in try/catch (primary-error preservation)', () => {
    const src = readFileSync(SOURCE, 'utf8');
    const lines = src.split('\n');
    const unguarded: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (!/\}\s*catch\s*\(/.test(lines[i] ?? '')) continue;

      // Find the matching closing brace for this catch block.
      let depth = 0;
      let started = false;
      let blockEnd = i;
      for (let j = i; j < lines.length; j++) {
        const text = lines[j] ?? '';
        for (const ch of text) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
            if (started && depth === 0) {
              blockEnd = j;
              break;
            }
          }
        }
        if (started && depth === 0) break;
      }

      const block = lines.slice(i, blockEnd + 1).join('\n');
      if (!/this\.#db\.exec\('ROLLBACK'\)/.test(block)) continue;
      const hasTryCatchWrapper = /try\s*\{[^}]*this\.#db\.exec\('ROLLBACK'\)[\s\S]*?\}\s*catch\s*\{/.test(
        block,
      );
      if (!hasTryCatchWrapper) unguarded.push(i + 1);
    }

    expect(
      unguarded,
      `Found ${unguarded.length} unguarded ROLLBACK call(s) in catch blocks at lines: ${unguarded.join(', ')}. ` +
        'These mask the primary SQLite error with the rollback noise. ' +
        'Use the try/catch wrapper from SessionCatalogStore.transaction (packages/core/src/session-catalog/store.ts).',
    ).toEqual([]);
  });
});
