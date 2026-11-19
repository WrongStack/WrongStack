import { describe, expect, it } from 'vitest';
import { hasRecursiveForceDelete } from '../../src/security/yolo-delete-risk.js';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { flagLetters } from '../../src/security/yolo-shell-scan.js';

/**
 * F6: GNU getopt_long accepts any unambiguous long-option prefix, so
 * `rm --rec --force ~/data` deletes exactly like `rm --recursive --force
 * ~/data`. flagLetters() matched only the exact long forms, so the abbreviated
 * spellings evaded the recursive-force-delete gate (a project-escaping
 * destructive delete auto-approved under YOLO). The PowerShell Remove-Item
 * branch already binds parameter prefixes; the POSIX rm branch now does too.
 */
describe('rm GNU long-option abbreviations are gated (F6)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'rm --rec --force ~/data',
    'rm --re --force ~/data',
    'rm --recursive --fo ~/data',
    'rm --recursive --forc ~/data',
    'rm --rec --fo ~/data',
    'rm --r --f ~/data',
    'rm --rec --force /etc',
  ])('gates the abbreviated escape: %s', (cmd) => {
    expect(hasRecursiveForceDelete(cmd, ROOT)).toBe(true);
  });

  it.each([
    'rm -rf ~/data',
    'rm -r -f ~/data',
    'rm -R --force ~/data',
    'rm --recursive --force ~/data',
    'rm -r --force ~/data',
  ])('still gates the full spelling: %s', (cmd) => {
    expect(hasRecursiveForceDelete(cmd, ROOT)).toBe(true);
  });

  it('classifies the abbreviated escape end-to-end as delete-outside', () => {
    expect(classifyDestructiveCommand('rm --rec --force ~/data', ROOT)).toBe('delete-outside');
    expect(classifyDestructiveCommand('rm -rf ~/data', ROOT)).toBe('delete-outside');
  });

  it.each(['rm ~/data', 'rm --force ~/data', 'rm --recursive ~/data', 'rm --verbose ~/data'])(
    'leaves a non-recursive-force delete safe: %s',
    (cmd) => {
      expect(hasRecursiveForceDelete(cmd, ROOT)).toBe(false);
    },
  );

  it('keeps an in-project recursive force delete frictionless', () => {
    expect(hasRecursiveForceDelete('rm --rec --force ./build', ROOT)).toBe(false);
    expect(hasRecursiveForceDelete('rm -rf ./build', ROOT)).toBe(false);
  });

  it('flagLetters binds the unambiguous prefixes', () => {
    expect(flagLetters(['--rec']).has('r')).toBe(true);
    expect(flagLetters(['--fo']).has('f')).toBe(true);
    expect(flagLetters(['--recursive']).has('r')).toBe(true);
    expect(flagLetters(['--force']).has('f')).toBe(true);
    expect(flagLetters(['-rf']).has('r')).toBe(true);
    expect(flagLetters(['-rf']).has('f')).toBe(true);
    expect(flagLetters(['--verbose']).has('r')).toBe(false);
    expect(flagLetters(['--verbose']).has('f')).toBe(false);
    // GNU rm rejects --recursive=yes (the option takes no argument); not matched.
    expect(flagLetters(['--recursive=yes']).has('r')).toBe(false);
  });
});
