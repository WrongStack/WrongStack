import { describe, expect, it } from 'vitest';
import {
  hasCatastrophicDelete,
  hasRecursiveForceDelete,
} from '../../src/security/yolo-delete-risk.js';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';

/**
 * F17 (surviving F6 twin): hasCatastrophicDelete matched rm/Remove-Item flags
 * by EXACT equality — it does not use flagLetters, which F6 fixed. GNU rm
 * accepts --r… ≡ --recursive, --f… ≡ --force, --n… ≡ --no-preserve-root (rm's
 * only n-option); PowerShell binds -rec ≡ -Recurse, -fo ≡ -Force and the short
 * -r/-f spellings. `rm --rec /` classified NOT catastrophic while `rm -r /`
 * was gated — a root/home wipe auto-approved under YOLO (the r-only form also
 * slips past hasRecursiveForceDelete's r&&f requirement, so nothing gated it).
 * The rm branch now uses flagLetters + a no-preserve-root prefix match; the
 * Remove-Item branch mirrors the recursive-force gate's parameter-prefix
 * patterns (recursive-OR-force semantics preserved).
 */
describe('catastrophic deletes bind verified flag abbreviations (F17)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'rm --rec /',
    'rm --re /',
    'rm --r /',
    'rm --fo ~',
    'rm --forc ~',
    'rm --f ~',
    'rm --no-preserve-roo /',
    'rm --no-preserve-root /',
    'rm --n /',
    'rm --rec',
    'rm --fo',
    'Remove-Item -rec -fo C:/Windows',
    'Remove-Item -r -f C:/Windows',
    'Remove-Item -recu -forc C:/Windows',
  ])('gates the abbreviated wipe: %s', (cmd) => {
    expect(hasCatastrophicDelete(cmd)).toBe(true);
  });

  it('classifies the abbreviated wipe end-to-end as delete-outside', () => {
    expect(classifyDestructiveCommand('rm --rec /', ROOT)).toBe('delete-outside');
    expect(classifyDestructiveCommand('rm --fo ~', ROOT)).toBe('delete-outside');
    expect(classifyDestructiveCommand('rm --rec ./build', ROOT)).toBeUndefined();
  });

  it.each([
    'rm -r /',
    'rm -rf /etc',
    'rm --recursive /',
    'rm --force ~',
    'rm --no-preserve-root /',
    'Remove-Item -Recurse -Force C:/Windows',
    'Remove-Item -Recurse:$true -Force:$true C:/Windows',
    'rmdir /s C:/Windows',
    'rd /s C:/Windows',
    'del C:/Windows',
    'erase C:/Windows',
  ])('still gates the canonical spelling: %s', (cmd) => {
    expect(hasCatastrophicDelete(cmd)).toBe(true);
  });

  it.each([
    'rm --verbose /',
    'rm --preserve-root /',
    'rm --rec ./build',
    'rm --fo file.txt',
    'rm file.txt',
    'Remove-Item -WhatIf C:/Windows',
    'Remove-Item -Filter *.tmp C:/Windows',
    'Remove-Item -Confirm C:/Windows',
    'Remove-Item -rec -fo ./build',
    'git status',
  ])('keeps the non-destructive spelling/target safe: %s', (cmd) => {
    expect(hasCatastrophicDelete(cmd)).toBe(false);
  });

  it('handles switch-value spellings and =value over-match', () => {
    expect(hasCatastrophicDelete('Remove-Item -rec:$true -fo:$true C:/Windows')).toBe(true);
    // recursive-OR-force: -Force alone still gates (existing semantics).
    expect(hasCatastrophicDelete('Remove-Item -Recurse:$false -Force C:/Windows')).toBe(true);
    // GNU rejects --no-preserve-root=x; over-matching is fail-safe.
    expect(hasCatastrophicDelete('rm --no-preserve-root=x /')).toBe(true);
  });

  it('sees abbreviated wipes behind launchers and chaining', () => {
    expect(hasCatastrophicDelete('sudo rm --rec /')).toBe(true);
    expect(hasCatastrophicDelete('true; rm --fo ~')).toBe(true);
  });

  it('leaves the F6 recursive-force gate intact (shared file)', () => {
    expect(hasRecursiveForceDelete('rm --rec --force ~/data', ROOT)).toBe(true);
    expect(hasRecursiveForceDelete('rm -rf ~/data', ROOT)).toBe(true);
    expect(hasRecursiveForceDelete('rm --rec ~/data', ROOT)).toBe(false);
    expect(hasRecursiveForceDelete('rm --rec --force ./build', ROOT)).toBe(false);
  });
});
