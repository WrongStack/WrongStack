import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';
import { longOptionAbbrev } from '../src/_danger-rule-utils.js';

/**
 * F11 (tools-side twin of core F8/F9): git's parse-options and AWS CLI's
 * argparse accept unambiguous long-option prefixes, so `git reset --har`,
 * `git clean --forc`, `git push --mirr/--dele/--pru`, `git checkout --forc`,
 * `git switch --disc`, `git restore --staged --wor`, `git gc --pru=now` and
 * `aws s3 rm --rec / rb --forc / sync --del` perform the same destruction as
 * their canonical spellings. The rules compared long options by exact equality,
 * so these classified safe and the exec result carried no destructive banner.
 * Parser semantics verified empirically in the core F8/F9 rounds (scratch git
 * repos + aws-cli/2.39.7), including the precision cases: push --forc and
 * switch --forc are AMBIGUOUS (git rejects them); aws sync --de/--d bind
 * --debug, NOT --delete; restore --sta is unstage-only safe.
 */
describe('VCS/infra danger rules bind verified long-option abbreviations (F11)', () => {
  it.each([
    ['git', ['reset', '--har', 'HEAD~1'], 'git-reset-hard'],
    ['git', ['reset', '--h', 'HEAD~1'], 'git-reset-hard'],
    ['git', ['clean', '--forc', '-d'], 'git-clean-force'],
    ['git', ['clean', '--f', '-d'], 'git-clean-force'],
    ['git', ['push', '--mirr'], 'git-push-delete'],
    ['git', ['push', '--m'], 'git-push-delete'],
    ['git', ['push', '--dele', 'origin', 'b'], 'git-push-delete'],
    ['git', ['push', '--de', 'origin', 'b'], 'git-push-delete'],
    ['git', ['push', '--pru'], 'git-push-delete'],
    ['git', ['checkout', '--forc'], 'git-discard-local-work'],
    ['git', ['checkout', '--f'], 'git-discard-local-work'],
    ['git', ['switch', '--disc', 'main'], 'git-discard-local-work'],
    ['git', ['switch', '--di', 'main'], 'git-discard-local-work'],
    ['git', ['restore', '--staged', '--wor', 'f'], 'git-discard-local-work'],
    ['git', ['restore', '--staged', '--w', 'f'], 'git-discard-local-work'],
    ['git', ['restore', '--sta', '--wor', 'f'], 'git-discard-local-work'],
    ['git', ['gc', '--pru=now'], 'git-discard-local-work'],
    ['git', ['gc', '--p=all'], 'git-discard-local-work'],
    ['aws', ['s3', 'rm', 's3://b', '--rec'], 'infra-teardown'],
    ['aws', ['s3', 'rb', 's3://b', '--forc'], 'infra-teardown'],
    ['aws', ['s3', 'rb', 's3://b', '--f'], 'infra-teardown'],
    ['aws', ['s3', 'sync', 's3://a', 's3://b', '--del'], 'infra-teardown'],
  ] as Array<[string, string[], string]>)(
    'classifies the abbreviated destruction: %s %s',
    (cmd, args, r) => {
      const assessment = detectDanger(cmd, args);
      expect(assessment.level).toBe('destructive');
      expect(assessment.matchedRule).toBe(r);
    },
  );

  it.each([
    ['git', ['reset', '--hard']],
    ['git', ['clean', '-fd']],
    ['git', ['clean', '--force', '-d']],
    ['git', ['push', '--mirror']],
    ['git', ['push', '--delete', 'origin', 'b']],
    ['git', ['push', '--prune']],
    ['git', ['push', '--force']],
    ['git', ['push', '--force-with-lease']],
    ['git', ['push', '--force-w']],
    ['git', ['checkout', '--force']],
    ['git', ['switch', '--discard-changes', 'main']],
    ['git', ['switch', '-f', 'main']],
    ['git', ['restore', '--staged', '--worktree', 'f']],
    ['git', ['gc', '--prune=now']],
    ['aws', ['s3', 'rm', 's3://b', '--recursive']],
  ] as Array<[string, string[]]>)('still classifies the canonical spelling: %s %s', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('destructive');
  });

  it.each([
    ['git', ['push', '--dry-run']],
    ['git', ['push', '--forc']],
    ['git', ['push', '--f']],
    ['git', ['push', '--d']],
    ['git', ['push', '--pr']],
    ['git', ['switch', '--forc']],
    ['git', ['switch', '--f']],
    ['git', ['restore', '--staged', 'f']],
    ['git', ['restore', '--sta', 'f']],
    ['git', ['gc', '--prune=2.weeks.ago']],
    ['git', ['gc', '--prune']],
    ['git', ['status']],
    ['git', ['switch', '-c', 'feat']],
    ['git', ['checkout', '-b', 'feat']],
    ['aws', ['s3', 'sync', 's3://a', 's3://b', '--de']],
    ['aws', ['s3', 'sync', 's3://a', 's3://b', '--d']],
    ['aws', ['s3', 'rm', 's3://b', '--re', 'us-east-1']],
    ['aws', ['s3', 'rm', 's3://b/key']],
    ['aws', ['s3', 'ls', 's3://b']],
  ] as Array<[string, string[]]>)('keeps the ambiguous/safe spelling safe: %s %s', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('safe');
  });

  it('keeps worktree restores gated and ambiguous restore flags fail-closed', () => {
    expect(detectDanger('git', ['restore', '--source=HEAD', 'f']).level).toBe('destructive');
    expect(detectDanger('git', ['restore', '--s', 'f']).level).toBe('destructive');
  });

  it('sees abbreviated destruction behind launchers and inline payloads', () => {
    expect(detectDanger('sudo', ['git', 'reset', '--har']).level).toBe('destructive');
    expect(detectDanger('env', ['git', 'clean', '--forc', '-d']).level).toBe('destructive');
    expect(detectDanger('bash', ['-c', 'git push --mirr']).level).toBe('destructive');
  });

  it('longOptionAbbrev binds prefixes at the verified floors only', () => {
    expect(longOptionAbbrev('--rec', 'recursive', 3)).toBe(true);
    expect(longOptionAbbrev('--re', 'recursive', 3)).toBe(false);
    expect(longOptionAbbrev('--dele', 'delete', 2)).toBe(true);
    expect(longOptionAbbrev('--d', 'delete', 2)).toBe(false);
    expect(longOptionAbbrev('--dry-run', 'delete', 2)).toBe(false);
    expect(longOptionAbbrev('--pru=now', 'prune', 1)).toBe(true);
    expect(longOptionAbbrev('-rf', 'force', 1)).toBe(false);
    expect(longOptionAbbrev('--HARD', 'hard', 1)).toBe(false);
  });

  it('leaves the F7 rm abbreviation rule intact (shared utils)', () => {
    expect(detectDanger('rm', ['--rec', '--force', '~/data']).level).toBe('destructive');
    expect(detectDanger('rm', ['--force', '~/data']).level).toBe('safe');
  });
});
