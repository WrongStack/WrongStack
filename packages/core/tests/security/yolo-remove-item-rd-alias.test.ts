import { describe, expect, it } from 'vitest';
import {
  hasCatastrophicDelete,
  hasRecursiveForceDelete,
} from '../../src/security/yolo-delete-risk.js';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';

/**
 * `rd` is a PowerShell alias for `Remove-Item` — probe-verified on
 * PowerShell 7 (Windows 11): `(Get-Alias rd).Definition` is `Remove-Item`, and
 * `rd -Recurse -Force <path>` binds both switches (a bogus `-RecurseBogus`
 * is the only spelling that fails with "A parameter cannot be found").
 *
 * The catastrophic-delete gate special-cases `Remove-Item`, `ri`, `del` and
 * `erase` for PowerShell parameter syntax, and `rd` only for cmd's `/s` form.
 * So `rd -Recurse -Force C:\Windows` — the same recursive force delete of a
 * system directory as `Remove-Item -Recurse -Force C:\Windows` — was the one
 * alias spelling that classified as safe and would be auto-approved under
 * YOLO. The `rd`/`rmdir` branches must accept the PowerShell switch form too.
 */
describe('PowerShell Remove-Item aliases gate a recursive force delete', () => {
  const ROOT = 'C:\\projects\\demo';

  it.each(['Remove-Item', 'ri', 'del', 'erase', 'rd'])(
    'gates `%s -Recurse -Force C:/Windows`',
    (alias) => {
      const cmd = `${alias} -Recurse -Force C:/Windows`;
      expect(hasCatastrophicDelete(cmd)).toBe(true);
      expect(hasRecursiveForceDelete(cmd, ROOT)).toBe(true);
      expect(classifyDestructiveCommand(cmd, ROOT)).toBe('delete-outside');
    },
  );

  it.each([
    'rd -rec -fo C:/Windows',
    'rd -Recurse:$true -Force:$true C:/Windows',
    'rd -Recurse -Force C:/Users',
    'rmdir -Recurse -Force C:/Windows',
  ])('gates the abbreviated / switch-value spelling: %s', (cmd) => {
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('delete-outside');
  });

  it('still gates cmd rt/dir spelling', () => {
    expect(hasCatastrophicDelete('rd /s /q C:/Windows')).toBe(true);
    expect(classifyDestructiveCommand('rd /s /q C:/Windows', ROOT)).toBe('delete-outside');
  });

  it('keeps an in-project recursive delete ungated', () => {
    const cmd = 'rd -Recurse -Force ./build';
    expect(hasCatastrophicDelete(cmd)).toBe(false);
    expect(hasRecursiveForceDelete(cmd, ROOT)).toBe(false);
    expect(classifyDestructiveCommand(cmd, ROOT)).toBeUndefined();
  });
});
