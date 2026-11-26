import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { tokenizeShell } from '../../src/security/yolo-shell-scan.js';

/**
 * PowerShell and cmd.exe do not treat `\` as an escape: in `"C:\proj\";cmd`
 * the second `"` closes the string and `;` separates the next command. The
 * scanner applied only the POSIX rule (`\"` is an escaped quote), kept the
 * string open, read the glued separator as prose and never tokenized the
 * command behind it, so a system-directory wipe classified as safe. A
 * separator now counts when EITHER reading leaves it unquoted; splitting a
 * POSIX-quoted `;` out of its string only ever makes the gates stricter.
 */
describe('a quoted path ending in a backslash cannot hide the next command', () => {
  const ROOT = 'C:\\projects\\demo';

  it.each([
    'Set-Location "C:\\proj\\";Remove-Item -Recurse -Force C:\\Windows',
    'Get-ChildItem "C:\\proj\\"|Remove-Item -Recurse -Force C:\\Windows',
    'cd "C:\\proj\\"&&rd /s /q C:\\Users',
  ])('gates `%s`', (cmd) => {
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('delete-outside');
  });

  it('a separator inside an ordinary quoted string is still prose', () => {
    const cmd = 'git commit -m "fix;Remove-Item -Recurse -Force C:\\Windows"';
    expect(tokenizeShell(cmd)).toContain('fix;Remove-Item -Recurse -Force C:\\Windows');
    expect(classifyDestructiveCommand(cmd, ROOT)).toBeUndefined();
  });
});
