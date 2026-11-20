import { describe, expect, it } from 'vitest';
import { commandRecursivelyDeletes, destructiveTargets } from '../src/path-guard/shell-targets.js';

/**
 * F16: git's parse-options and PowerShell accept any UNAMBIGUOUS long-option
 * (parameter) prefix, so `rm --rec`, `git rm --r`, `git reset --har`,
 * `git restore --staged --wor`, `Remove-Item -rec` perform the same destruction
 * as their canonical spellings. The classifiers matched long options by exact
 * equality, so the abbreviated forms evaded the recursive-delete / reset /
 * restore scope classification: path-guard/index.ts downgraded a
 * deletion-scope to a file target (or dropped it), and a recursive delete of
 * protected descendants drew no verdict. Parser semantics verified empirically
 * in the core F6/F8 rounds (scratch repos). Floors: rm/git-rm --recursive "r";
 * reset --hard "h", --merge "me" ("m" collides with --mixed), --keep "k";
 * restore --staged "sta" ("s"/"st" collide with --source), --worktree "w";
 * PowerShell -Recurse binds any prefix (-r, -re, -rec…), case-insensitive.
 */
describe('path-guard binds verified long-option abbreviations (F16)', () => {
  it.each([
    'rm --rec build',
    'rm --re build',
    'rm --r build',
    'Remove-Item -rec -force build',
    'Remove-Item -recu -force build',
    'sudo rm --rec build',
    'env rm --r build',
    '(rm --rec build)',
    '{ rm --rec build; }',
  ])('classifies the abbreviated recursive delete: %s', (cmd) => {
    expect(commandRecursivelyDeletes(cmd)).toBe(true);
  });

  it.each([
    'rm -rf build',
    'rm -r build',
    'rm --recursive build',
    'Remove-Item -Recurse -Force build',
    'Remove-Item -Recurse:$true -Force build',
  ])('still classifies the canonical recursive delete: %s', (cmd) => {
    expect(commandRecursivelyDeletes(cmd)).toBe(true);
  });

  it.each([
    ['git rm --rec dir', 'dir/**'],
    ['git rm --r dir', 'dir/**'],
    ['git reset --har', '.'],
    ['git reset --mer', '.'],
    ['git reset --kee', '.'],
    ['git restore --staged --wor f', 'f/**'],
    ['git restore --staged --w f', 'f/**'],
    ['true; git reset --har', '.'],
    // git rejects --har=x (hard takes no value); over-matching is fail-safe.
    ['git reset --har=x', '.'],
  ])('expands the abbreviated destructive scope: %s', (cmd, scope) => {
    expect(destructiveTargets(cmd)).toContain(scope);
  });

  it.each([
    ['git rm -r dir', 'dir/**'],
    ['git reset --hard', '.'],
    ['git reset --merge', '.'],
    ['git reset --keep', '.'],
    ['git restore --staged --worktree f', 'f/**'],
  ])('still expands the canonical scope: %s', (cmd, scope) => {
    expect(destructiveTargets(cmd)).toContain(scope);
  });

  it.each(['rm build', 'rm --verbose build', 'rm --force build'])(
    'keeps the non-recursive rm non-recursive (target still extracted): %s',
    (cmd) => {
      expect(commandRecursivelyDeletes(cmd)).toBe(false);
      // A non-recursive rm still names its operand for the protect check.
      expect(destructiveTargets(cmd)).toContain('build');
    },
  );

  it.each([
    'git reset --soft',
    'git reset --mixed',
    'git reset --help',
    'git restore --staged f',
    'git restore --sta f',
    'git rm --cached dir',
    'git rm --cached --rec dir',
  ])('keeps the non-destructive git spelling ungated: %s', (cmd) => {
    expect(destructiveTargets(cmd)).toHaveLength(0);
  });

  it('keeps worktree restores gated and ambiguous restore flags fail-closed', () => {
    expect(destructiveTargets('git restore --source=HEAD f')).toContain('f/**');
    expect(destructiveTargets('git restore --s f')).toContain('f/**');
  });

  it('leaves the adjacent classifiers unchanged', () => {
    expect(destructiveTargets('git checkout -- .')).toContain('**');
    expect(destructiveTargets('find . -delete').length).toBeGreaterThan(0);
    // This classifier has no -WhatIf exemption (the core/tools rules do);
    // pinned so a future exemption lands as a deliberate change.
    expect(commandRecursivelyDeletes('Remove-Item -Recurse -Force -WhatIf build')).toBe(true);
  });
});
