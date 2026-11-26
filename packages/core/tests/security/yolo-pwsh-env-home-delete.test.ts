import { describe, expect, it } from 'vitest';
import { hasCatastrophicDelete } from '../../src/security/yolo-delete-risk.js';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';

/**
 * PowerShell spells the home directory `$env:USERPROFILE` (or `${env:...}`),
 * the same directory cmd spells `%USERPROFILE%` and POSIX shells `$HOME`.
 * `Remove-Item -Recurse` (no -Force) deletes the tree without a prompt, so only
 * the catastrophic-target check stands between it and YOLO auto-approval; it
 * knew `~`, `$HOME`, `${HOME}` and `%USERPROFILE%`, but not the env-drive form.
 */
describe('PowerShell env-drive home spellings are catastrophic delete targets', () => {
  const ROOT = 'C:\\projects\\demo';

  it.each([
    'Remove-Item -Recurse $env:USERPROFILE',
    'Remove-Item -Recurse $Env:UserProfile\\',
    'rd -Recurse ${env:USERPROFILE}',
    'ri -Recurse $env:HOME',
    'del $env:USERPROFILE\\*',
  ])('gates `%s`', (cmd) => {
    expect(hasCatastrophicDelete(cmd)).toBe(true);
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('delete-outside');
  });

  it('a subdirectory of the profile stays recoverable-scale', () => {
    expect(hasCatastrophicDelete('Remove-Item -Recurse $env:USERPROFILE\\tmp')).toBe(false);
  });
});
