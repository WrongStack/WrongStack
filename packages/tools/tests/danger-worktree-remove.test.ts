import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';

/**
 * F14 (tools-side twin of core F13): `git worktree remove --force` deletes a
 * worktree checkout even when dirty — uncommitted work is lost with no reflog
 * for it (probe-verified in scratch repos, round 24: --force/-f/--forc/--f all
 * removed the dirty worktree; plain remove REFUSES a dirty worktree and a
 * clean removal loses nothing). The git-discard-local-work rule had no
 * 'worktree' case. remove's only f-option is --force, so --f… is unambiguous
 * (minLen 1). Other verbs (add/list/lock/unlock/move/prune/repair) discard no
 * work and stay safe, even with a force flag.
 */
describe('git worktree remove --force is destructive (F14)', () => {
  it.each([
    ['worktree', 'remove', '--force', '../wt'],
    ['worktree', 'remove', '-f', '../wt'],
    ['worktree', 'remove', '--forc', '../wt'],
    ['worktree', 'remove', '--f', '../wt'],
    ['worktree', 'remove', '--force', '.'],
    ['worktree', 'remove', '--force'],
  ])('classifies the force removal: git %s', (...args) => {
    const assessment = detectDanger('git', args);
    expect(assessment.level).toBe('destructive');
    expect(assessment.matchedRule).toBe('git-discard-local-work');
  });

  it.each([
    ['worktree', 'remove', '../wt'],
    ['worktree', 'add', '../wt', '-b', 'newbranch'],
    ['worktree', 'add', '--force', '../wt', 'branch'],
    ['worktree', 'list'],
    ['worktree', 'list', '--force'],
    ['worktree', 'prune'],
    ['worktree', 'prune', '--force'],
    ['worktree', 'lock', '../wt'],
    ['worktree', 'unlock', '../wt'],
    ['worktree', 'move', '../wt', '../wt2'],
    ['worktree', 'repair'],
    ['status'],
  ])('keeps the non-destructive verb safe: git %s', (...args) => {
    expect(detectDanger('git', args).level).toBe('safe');
  });

  it('sees force removals regardless of flag order, globals, launchers, inline', () => {
    expect(detectDanger('git', ['worktree', '--force', 'remove', 'wt']).level).toBe('destructive');
    expect(detectDanger('git', ['-C', '/tmp', 'worktree', 'remove', '-f', 'wt']).level).toBe(
      'destructive',
    );
    expect(detectDanger('git', ['-c', 'k=v', 'worktree', 'remove', '--force', 'wt']).level).toBe(
      'destructive',
    );
    expect(detectDanger('sudo', ['git', 'worktree', 'remove', '-f', 'wt']).level).toBe(
      'destructive',
    );
    expect(detectDanger('bash', ['-c', 'git worktree remove --force wt']).level).toBe(
      'destructive',
    );
  });

  it('leaves the F12/F11/F7 rules intact (shared file)', () => {
    expect(detectDanger('git', ['branch', '-D', 'feat']).level).toBe('destructive');
    expect(detectDanger('git', ['switch', '-C', 'feat']).level).toBe('destructive');
    expect(detectDanger('git', ['branch', '-f', '--list']).level).toBe('safe');
    expect(detectDanger('git', ['switch', '-c', 'feat']).level).toBe('safe');
    expect(detectDanger('git', ['reset', '--har', 'HEAD~1']).level).toBe('destructive');
    expect(detectDanger('git', ['restore', '--sta', 'f']).level).toBe('safe');
    expect(detectDanger('git', ['push', '--mirr']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '--dry-run']).level).toBe('safe');
    expect(detectDanger('rm', ['--rec', '--force', '~/data']).level).toBe('destructive');
  });
});
