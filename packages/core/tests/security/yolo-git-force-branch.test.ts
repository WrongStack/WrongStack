import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { hasExternalPublish, hasGitHistoryRewrite } from '../../src/security/yolo-vcs-risk.js';

/**
 * F10: force branch-ref manipulation discards a branch's unique commits
 * (reflog-only recovery) and was not gated at all. Probe-verified in scratch
 * repos (each form RESET feat to main or DELETED it, losing unmerged commit B):
 *   switch -C/--force-create (also --force-c…, -Cfeat, clustered -qC)
 *   checkout -B (also -Bfeat, clustered -qB)
 *   branch -f <name> [start] / --forc <name>      (forced reset)
 *   branch -D / -fd / -fD / --delete --force     (force delete)
 *   branch -M / --move --force                   (force move, target overwritten)
 *   branch -C / --copy --force                   (force copy, target overwritten)
 * git short flags are CASE-SENSITIVE: -c/-C, -b/-B, -d/-D, -m/-M are safe/force
 * pairs, so the force variants are detected on original-case tokens (the
 * lowercased stream collapses them). Verified abbreviation floors: switch
 * --force-create "force-c" (7); branch --force "forc" (4, "for"/"f" collide
 * with --forked/--format); --move "mo"; --copy "cop"; --delete EXACT only
 * ("del" ambiguous with --delete-merged). `branch -f --list` is harmless —
 * list/filter modes are excluded from the forced-reset path.
 */
describe('git force branch-ref manipulation is gated (F10)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'git switch -C feat',
    'git switch --force-create feat',
    'git switch --force-c feat',
    'git switch --force-cr feat',
    'git switch -Cfeat',
    'git checkout -B feat',
    'git checkout -Bfeat',
    'git branch -f feat HEAD',
    'git branch -f feat',
    'git branch --forc feat HEAD',
    'git branch -D feat',
    'git branch -fd feat',
    'git branch -fD feat',
    'git branch --delete --force feat',
    'git branch -M feat taken',
    'git branch -Mfeat taken',
    'git branch --move --force feat taken',
    'git branch --mo --forc feat taken',
    'git branch -C feat copied',
    'git branch --copy --force feat copied',
    'git branch --cop --forc feat copied',
    'git branch --delete-merged --force feat',
  ])('gates the force branch operation: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(true);
  });

  it.each(['git switch -C feat', 'git checkout -B feat', 'git branch -D feat'])(
    'classifies end-to-end as git-history: %s',
    (cmd) => {
      expect(classifyDestructiveCommand(cmd, ROOT)).toBe('git-history');
    },
  );

  it.each([
    'git switch -c feat',
    'git switch --create feat',
    'git checkout -b feat',
    'git branch -m feat taken',
    'git branch -c feat copied',
    'git branch -d feat',
    'git branch --delete feat',
    'git branch --delete-merged feat',
    'git branch newone',
    'git branch -f',
  ])('keeps the lowercase safe-create pair safe: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(false);
  });

  it.each([
    'git branch -f --list',
    "git branch -f --list 'feat*'",
    'git branch --list',
    'git branch -a',
    'git branch -f -a',
    'git branch -r',
    'git branch --contains HEAD',
    'git branch -f --contains HEAD',
    'git branch -f --merged main',
    'git branch -f --sort=-committerdate',
    'git branch -f --format=%(refname)',
    'git branch --show-current',
    'git branch -f --show-current',
  ])('keeps list/filter mode safe even with -f: %s', (cmd) => {
    expect(hasGitHistoryRewrite(cmd)).toBe(false);
  });

  it('sees clusters, attached values, global options, and chaining', () => {
    expect(hasGitHistoryRewrite('git switch -qC feat')).toBe(true);
    expect(hasGitHistoryRewrite('git checkout -qB feat')).toBe(true);
    expect(hasGitHistoryRewrite('git -C /tmp branch -D feat')).toBe(true);
    expect(hasGitHistoryRewrite('git -c k=v switch -C feat')).toBe(true);
    expect(hasGitHistoryRewrite('true; git branch -D feat')).toBe(true);
  });

  it('keeps git-rejected ambiguous abbreviations precise', () => {
    // "for"/"f" collide with --forked/--format; git rejects them.
    expect(hasGitHistoryRewrite('git branch --for feat HEAD')).toBe(false);
    expect(hasGitHistoryRewrite('git branch --f feat HEAD')).toBe(false);
    // "del" is ambiguous (--delete vs --delete-merged); with --force present
    // the forced-reset path over-gates the git-rejected spelling (fail-safe).
    expect(hasGitHistoryRewrite('git branch --del --forc feat')).toBe(true);
  });

  it('leaves the F8/F9 gates intact (shared file/helper)', () => {
    for (const cmd of [
      'git reset --har HEAD~1',
      'git clean --forc -d',
      'git push --force-w',
      'git restore --staged --wor file',
      'git gc --pru=now',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(true);
    }
    for (const cmd of [
      'git push --forc',
      'git switch --forc',
      'git push --dry-run',
      'git restore --sta file',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(false);
    }
    expect(hasExternalPublish('aws s3 rm s3://b --rec')).toBe(true);
    expect(hasExternalPublish('aws s3 sync s3://a s3://b --de')).toBe(false);
  });
});
