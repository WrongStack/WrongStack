import { describe, expect, it } from 'vitest';
import {
  buildVibeTreeCommandArgs,
  flattenVibeBranchRows,
  parseVibeSessionTree,
} from '../src/lib/session-branch-model';

describe('VibeUI session-branch-model', () => {
  it('parses valid /tree list --json snapshots and rejects malformed payloads', () => {
    expect(parseVibeSessionTree('')).toBeNull();
    expect(parseVibeSessionTree('not json')).toBeNull();
    expect(parseVibeSessionTree(JSON.stringify({ foo: 'bar' }))).toBeNull();

    const raw = JSON.stringify({
      version: 1,
      activeBranchId: 'spike-1',
      branches: {
        main: {
          id: 'main',
          name: 'main',
          parentBranchId: null,
          forkSeq: 0,
          createdAt: '2026-11-12T10:00:00.000Z',
          lastActivityAt: '2026-11-12T10:05:00.000Z',
          status: 'active',
          turnCount: 3,
        },
        'spike-1': {
          id: 'spike-1',
          name: 'spike-1',
          parentBranchId: 'main',
          forkSeq: 4,
          createdAt: '2026-11-12T10:06:00.000Z',
          lastActivityAt: '2026-11-12T10:08:00.000Z',
          status: 'active',
          turnCount: 2,
        },
      },
    });
    const parsed = parseVibeSessionTree(raw);
    expect(parsed?.activeBranchId).toBe('spike-1');
    const rows = flattenVibeBranchRows(parsed!);
    expect(rows.map((r) => ({ id: r.branch.id, depth: r.depth, isActive: r.isActive }))).toEqual([
      { id: 'main', depth: 0, isActive: false },
      { id: 'spike-1', depth: 1, isActive: true },
    ]);
  });

  it('builds deterministic /tree subcommand arguments including --keep-files', () => {
    expect(buildVibeTreeCommandArgs({ kind: 'list' })).toBe('list --json');
    expect(buildVibeTreeCommandArgs({ kind: 'new', name: '  exp-cache ' })).toBe('new exp-cache');
    expect(buildVibeTreeCommandArgs({ kind: 'switch', branchId: 'main' })).toBe('switch main');
    expect(buildVibeTreeCommandArgs({ kind: 'switch', branchId: 'main', keepFiles: true })).toBe(
      'switch main --keep-files',
    );
    expect(buildVibeTreeCommandArgs({ kind: 'fold', branchId: 'exp-cache' })).toBe(
      'fold exp-cache',
    );
  });
});
