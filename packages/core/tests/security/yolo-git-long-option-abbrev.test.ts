import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { hasGitHistoryRewrite } from '../../src/security/yolo-vcs-risk.js';

/**
 * F8: git's parse-options accepts any UNAMBIGUOUS long-option prefix, so
 * `git reset --har` ≡ `--hard`, `git clean --forc` ≡ `--force`, etc. The gates
 * compared long options by exact equality, so these git-executed spellings
 * were classified safe and auto-approved under YOLO. Verified empirically in
 * scratch repos (shortest unambiguous prefix per command):
 *   reset --hard: --h…       clean --force: --f…
 *   push --force-with-lease: --force-w…   push --mirror: --m…
 *   push --delete: --de… ("d" ambiguous w/ --dry-run)
 *   push --prune: --pru… ("p"/"pr" ambiguous w/ porcelain/progress/push-option)
 *   switch --discard-changes: --di… ("d" ambiguous w/ --detach)
 *   checkout --force: --f…   restore --worktree: --w…  restore --staged: --sta…
 *   gc --prune: --p…
 * git REJECTS as ambiguous (must NOT be gated): push --f…--forc (force vs
 * force-with-lease vs force-if-includes), switch --f…--forc (force vs
 * force-create), push --force itself has no accepted abbreviation.
 */
describe('git unambiguous long-option abbreviations are gated (F8)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'git reset --har HEAD~1',
    'git reset --h HEAD~1',
    'git reset --ha HEAD~1',
    'git clean --forc -d',
    'git clean --f -d',
    'git clean --fo -d',
    'git push --force-w',
    'git push --force-wi',
    'git push --force-with-leas',
    'git push --mirr',
    'git push --m',
    'git push --dele origin branch',
    'git push --de origin branch',
    'git push --pru',
    'git switch --disc main',
    'git switch --di main',
    'git switch --discard-change main',
    'git checkout --forc',
    'git checkout --f',
    'git restore --staged --wor file',
    'git restore --staged --w file',
    'git gc --pru=now',
    'git gc --p=all',
  ])('gates the git-accepted abbreviation: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(true);
  });

  it.each([
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean --force -d',
    'git push -f',
    'git push --force',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc',
    'git push --mirror',
    'git push --delete origin branch',
    'git push --prune',
    'git push origin +main',
    'git switch --discard-changes main',
    'git switch -f main',
    'git checkout --force',
    'git checkout -f',
    'git restore --staged --worktree file',
    'git restore -w file',
    'git gc --prune=now',
    'git gc --prune=all',
    'git stash clear',
    'git reflog expire --expire=now --all',
  ])('still gates the canonical spelling: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(true);
  });

  it.each([
    'git reset --har HEAD~1',
    'git clean --forc -d',
    'git push --force-w',
    'git reset --hard',
  ])('classifies end-to-end as git-history: %s', (cmd) => {
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('git-history');
  });

  it.each([
    'git push --forc',
    'git push --f',
    'git push --force-i',
    'git switch --forc',
    'git switch --f',
    'git push --d',
    'git push --p',
    'git push --pr',
    'git switch --d',
  ])('does not gate a git-rejected ambiguous abbreviation: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(false);
  });

  it('fails closed on ambiguous restore flags with a pathspec', () => {
    // Never the unstage-only exemption: unknown/ambiguous flag + pathspec is gated.
    expect(hasGitHistoryRewrite('git restore --s file')).toBe(true);
    expect(hasGitHistoryRewrite('git restore --st file')).toBe(true);
  });

  it.each([
    'git push --dry-run',
    'git push --progress',
    'git push --porcelain',
    'git push --force-if-includes',
    'git restore --staged file',
    'git restore --sta file',
    'git gc --prune=2.weeks.ago',
    'git gc --prune',
    'git status',
    'git log --oneline',
    'git reset --soft HEAD~1',
    'git reset --mixed HEAD~1',
    'git checkout main',
    'git switch main',
  ])('keeps the safe workflow safe: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(false);
  });

  it('keeps the documented dry-run asymmetry and source-restore gating', () => {
    // This layer flags lease force-pushes even with --dry-run (documented
    // asymmetry vs the tools-side rule); a worktree restore is gated.
    expect(hasGitHistoryRewrite('git push --dry-run --force-with-lease')).toBe(true);
    expect(hasGitHistoryRewrite('git restore --source=HEAD file')).toBe(true);
    expect(hasGitHistoryRewrite('git restore --sou=HEAD file')).toBe(true);
  });

  it('handles =value forms, mixed spellings, and restore combinations', () => {
    expect(hasGitHistoryRewrite('git push --force-w=main:abc')).toBe(true);
    // git rejects --har=x (hard takes no value); over-matching is fail-safe.
    expect(hasGitHistoryRewrite('git reset --har=x')).toBe(true);
    expect(hasGitHistoryRewrite('git clean -d --forc')).toBe(true);
    expect(hasGitHistoryRewrite('git clean -fd')).toBe(true);
    expect(hasGitHistoryRewrite('git restore --sta --wor file')).toBe(true);
    expect(hasGitHistoryRewrite('git restore --sta file')).toBe(false);
  });

  it('sees abbreviated rewrites in chained and global-option forms', () => {
    expect(hasGitHistoryRewrite('true; git reset --har')).toBe(true);
    expect(hasGitHistoryRewrite('git -C /tmp reset --har')).toBe(true);
  });
});
