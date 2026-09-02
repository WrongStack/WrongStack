import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isKanbanBoardActive } from '../../src/lib/kanban-board-active.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('isKanbanBoardActive — the single board-active predicate', () => {
  it('is active when any presence entry is live', () => {
    expect(
      isKanbanBoardActive(
        { presence: [{ active: false } as never, { active: true } as never] },
        [],
      ),
    ).toBe(true);
    expect(isKanbanBoardActive({ presence: [{ active: false } as never] }, [])).toBe(false);
  });

  it('is active when a session tag names a live session', () => {
    const tagged = { tags: ['run:goal-1', 'session:abc'] };
    expect(isKanbanBoardActive(tagged, ['abc'])).toBe(true);
    expect(isKanbanBoardActive(tagged, ['other'])).toBe(false);
    // No session knowledge degrades to presence-only — the documented
    // behavior of store-side fallback totals, not a second definition.
    expect(isKanbanBoardActive(tagged, [])).toBe(false);
  });

  it('is orphaned with neither presence nor tags', () => {
    expect(isKanbanBoardActive({}, ['abc'])).toBe(false);
  });

  it('remains the only definition on the client', () => {
    // The bug this pins: kanban-store.ts carried a private presence-only
    // copy while KanbanView filtered with the richer predicate, so the
    // sidebar heading counted a different set than the list below it.
    const store = readFileSync(join(ROOT, 'src', 'stores', 'kanban-store.ts'), 'utf8');
    expect(store).toContain("from '../lib/kanban-board-active.js'");
    expect(store).not.toMatch(/presence\?\.some\(\(entry\) => entry\.active\)/);
    const boardState = readFileSync(join(ROOT, 'src', 'components', 'KanbanBoardState.ts'), 'utf8');
    expect(boardState).toContain(
      "export { isKanbanBoardActive } from '../lib/kanban-board-active.js'",
    );
  });

  it('matches the server-side twin in kanban-route-pagination.ts', () => {
    // Cross-package source pin: the server computes activeTotal with an
    // inline predicate that must keep the same two clauses (live presence
    // OR session:<id> tag among the live session ids). If this fails,
    // update BOTH sides deliberately — the server totals land in the same
    // store fields the client fallback feeds.
    const serverSrc = readFileSync(
      join(ROOT, '..', 'webui-server', 'src', 'server', 'kanban-route-pagination.ts'),
      'utf8',
    );
    expect(serverSrc).toMatch(/presence\?\.some\(\(entry\) => entry\.active\) === true/);
    expect(serverSrc).toMatch(/tag\.startsWith\('session:'\)/);
  });
});
