import { describe, expect, it } from 'vitest';
import {
  COMMIT_DETAIL_PANEL_CLASS,
  layoutCommitGraph,
} from '../../src/components/RepositoryHistoryView';

const commit = (hash: string, parents: string[]) => ({
  hash,
  parents,
  author: 'Ada Lovelace',
  email: 'ada@example.test',
  authoredAt: '2026-09-09T10:00:00.000Z',
  subject: hash,
  refs: [],
});

describe('repository history graph layout', () => {
  it('keeps commit details in a bottom split panel', () => {
    expect(COMMIT_DETAIL_PANEL_CLASS).toContain('border-t');
    expect(COMMIT_DETAIL_PANEL_CLASS).toContain('sm:h-[36%]');
    expect(COMMIT_DETAIL_PANEL_CLASS).toContain('sm:flex-row');
    expect(COMMIT_DETAIL_PANEL_CLASS).not.toContain('border-l');
  });

  it('keeps the first-parent line stable and fans merge parents into another lane', () => {
    const layout = layoutCommitGraph([
      commit('merge', ['main', 'feature']),
      commit('feature', ['base']),
      commit('main', ['base']),
      commit('base', []),
    ]);

    expect(layout.lanes[0]).toBe(0);
    expect(layout.laneCount).toBeGreaterThanOrEqual(2);
    expect(layout.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromRow: 0, toRow: 1 }),
        expect.objectContaining({ fromRow: 0, toRow: 2 }),
      ]),
    );
  });
});
