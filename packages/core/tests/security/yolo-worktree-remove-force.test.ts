import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { hasGitHistoryRewrite } from '../../src/security/yolo-vcs-risk.js';

/**
 * F13: `git worktree remove --force` deletes a worktree checkout even when
 * dirty — uncommitted work is lost with no reflog for it (probe-verified in
 * scratch repos: --force/-f/--forc/--f all removed the dirty worktree; plain
 * remove REFUSES a dirty worktree and a clean removal loses nothing). Same
 * irreversible-local-work class as checkout -f / clean -f, but discardsLocalWork
 * had no 'worktree' case. remove's only f-option is --force, so --f… is
 * unambiguous (minLen 1). Other verbs (add/list/lock/unlock/move/prune/repair)
 * discard no work and stay safe, even with a force flag.
 */
describe('git worktree remove --force is gated (F13)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'git worktree remove --force ../wt',
    'git worktree remove -f ../wt',
    'git worktree remove --forc ../wt',
    'git worktree remove --f ../wt',
    'git worktree remove --force .',
    'git worktree remove --force',
  ])('gates the force removal: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(true);
  });

  it.each(['git worktree remove --force ../wt', 'git worktree remove -f ../wt'])(
    'classifies end-to-end as git-history: %s',
    (cmd) => {
      expect(classifyDestructiveCommand(cmd, ROOT)).toBe('git-history');
    },
  );

  it.each([
    'git worktree remove ../wt',
    'git worktree add ../wt -b newbranch',
    'git worktree add --force ../wt branch',
    'git worktree list',
    'git worktree list --force',
    'git worktree prune',
    'git worktree prune --force',
    'git worktree lock ../wt',
    'git worktree unlock ../wt',
    'git worktree move ../wt ../wt2',
    'git worktree repair',
    'git status',
  ])('keeps the non-destructive verb safe: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(false);
  });

  it('sees force removals regardless of flag order, globals, and chaining', () => {
    expect(hasGitHistoryRewrite('git worktree --force remove wt')).toBe(true);
    expect(hasGitHistoryRewrite('git -C /tmp worktree remove -f wt')).toBe(true);
    expect(hasGitHistoryRewrite('true; git worktree remove --force wt')).toBe(true);
  });

  it('leaves the F8/F10 gates intact (shared function)', () => {
    for (const cmd of [
      'git reset --har HEAD~1',
      'git clean --forc -d',
      'git push --force-w',
      'git switch -C feat',
      'git branch -D feat',
      'git branch -f feat HEAD',
      'git restore --staged --wor file',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(true);
    }
    for (const cmd of [
      'git push --forc',
      'git switch -c feat',
      'git branch -f --list',
      'git restore --sta file',
      'git push --dry-run',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(false);
    }
  });
});
