import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';

/**
 * F12 (tools-side twin of core F10): force branch-ref manipulation discards a
 * branch's unique commits (reflog-only recovery); move/copy also OVERWRITES an
 * existing target. The git-discard-local-work rule had no 'branch' case and no
 * -C/-B coverage. Probe-verified in scratch repos (round 21): each form RESET
 * feat to main or DELETED it, losing unmerged commit B. Tools args are
 * case-sensitive, so the uppercase force short flags (-C/-B/-D/-M) are detected
 * directly and the lowercase safe-create pairs (-c/-b/-d/-m) never match.
 * Verified abbreviation floors: switch --force-create "force-c" (7); branch
 * --force "forc" (4, "for"/"f" collide with --forked/--format); --move "mo";
 * --copy "cop"; --delete EXACT only ("del" ambiguous with --delete-merged).
 * `branch -f --list` is harmless — list/filter modes are excluded.
 */
describe('git force branch-ref manipulation is destructive (F12)', () => {
  it.each([
    ['switch', '-C', 'feat'],
    ['switch', '--force-create', 'feat'],
    ['switch', '--force-c', 'feat'],
    ['switch', '--force-cr', 'feat'],
    ['switch', '-Cfeat'],
    ['switch', '-qC', 'feat'],
    ['checkout', '-B', 'feat'],
    ['checkout', '-Bfeat'],
    ['checkout', '-qB', 'feat'],
    ['branch', '-f', 'feat', 'HEAD'],
    ['branch', '-f', 'feat'],
    ['branch', '--forc', 'feat', 'HEAD'],
    ['branch', '-D', 'feat'],
    ['branch', '-fd', 'feat'],
    ['branch', '-fD', 'feat'],
    ['branch', '--delete', '--force', 'feat'],
    ['branch', '-M', 'feat', 'taken'],
    ['branch', '-Mfeat', 'taken'],
    ['branch', '--move', '--force', 'feat', 'taken'],
    ['branch', '--mo', '--forc', 'feat', 'taken'],
    ['branch', '-C', 'feat', 'copied'],
    ['branch', '--copy', '--force', 'feat', 'copied'],
    ['branch', '--cop', '--forc', 'feat', 'copied'],
    ['branch', '--delete-merged', '--force', 'feat'],
  ])('classifies the force branch operation: git %s', (...args) => {
    const assessment = detectDanger('git', args);
    expect(assessment.level).toBe('destructive');
    expect(assessment.matchedRule).toBe('git-discard-local-work');
  });

  it.each([
    ['switch', '-c', 'feat'],
    ['switch', '--create', 'feat'],
    ['checkout', '-b', 'feat'],
    ['branch', '-m', 'feat', 'taken'],
    ['branch', '-c', 'feat', 'copied'],
    ['branch', '-d', 'feat'],
    ['branch', '--delete', 'feat'],
    ['branch', '--delete-merged', 'feat'],
    ['branch', 'newone'],
    ['branch', '-f'],
  ])('keeps the lowercase safe-create pair safe: git %s', (...args) => {
    expect(detectDanger('git', args).level).toBe('safe');
  });

  it.each([
    ['branch', '-f', '--list'],
    ['branch', '-f', '--list', 'feat*'],
    ['branch', '--list'],
    ['branch', '-a'],
    ['branch', '-f', '-a'],
    ['branch', '-r'],
    ['branch', '--contains', 'HEAD'],
    ['branch', '-f', '--contains', 'HEAD'],
    ['branch', '-f', '--merged', 'main'],
    ['branch', '-f', '--sort=-committerdate'],
    ['branch', '-f', '--format=%(refname)'],
    ['branch', '--show-current'],
    ['branch', '-f', '--show-current'],
  ])('keeps list/filter mode safe even with -f: git %s', (...args) => {
    expect(detectDanger('git', args).level).toBe('safe');
  });

  it('sees force branches behind global options, launchers, and inline payloads', () => {
    expect(detectDanger('git', ['-C', '/tmp', 'branch', '-D', 'feat']).level).toBe('destructive');
    expect(detectDanger('git', ['-c', 'k=v', 'switch', '-C', 'feat']).level).toBe('destructive');
    expect(detectDanger('sudo', ['git', 'branch', '-D', 'feat']).level).toBe('destructive');
    expect(detectDanger('bash', ['-c', 'git switch -C feat']).level).toBe('destructive');
  });

  it('keeps git-rejected ambiguous abbreviations precise', () => {
    expect(detectDanger('git', ['branch', '--for', 'feat', 'HEAD']).level).toBe('safe');
    expect(detectDanger('git', ['branch', '--f', 'feat', 'HEAD']).level).toBe('safe');
    // "del" ambiguous; with --force the forced-reset path over-gates the
    // git-rejected spelling (fail-safe, core parity).
    expect(detectDanger('git', ['branch', '--del', '--forc', 'feat']).level).toBe('destructive');
  });

  it('leaves the F11/F7 rules intact (shared file)', () => {
    expect(detectDanger('git', ['reset', '--har', 'HEAD~1']).level).toBe('destructive');
    expect(detectDanger('git', ['restore', '--sta', 'f']).level).toBe('safe');
    expect(detectDanger('git', ['restore', '--staged', '--wor', 'f']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '--mirr']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '--dry-run']).level).toBe('safe');
    expect(detectDanger('rm', ['--rec', '--force', '~/data']).level).toBe('destructive');
  });
});
