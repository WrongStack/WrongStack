import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';
import { flagLetters } from '../src/_danger-rule-utils.js';

/**
 * F7 (tools-side twin of F6): GNU getopt_long accepts any unambiguous
 * long-option prefix, so `rm --rec --force ~/data` deletes exactly like
 * `rm --recursive --force ~/data`. flagLetters() matched only the exact long
 * forms, so the abbreviated spellings classified as 'safe' and the exec result
 * carried no destructive banner/risk metadata while the canonical spelling
 * triggered it. The PowerShell Remove-Item rule in this package already binds
 * parameter-name prefixes; the POSIX rm rule now does too, matching core's
 * yolo-shell-scan flagLetters (F6).
 */
describe('rm GNU long-option abbreviations are destructive (F7)', () => {
  it.each([
    ['--rec', '--force', '~/data'],
    ['--re', '--force', '~/data'],
    ['--recursive', '--fo', '~/data'],
    ['--recursive', '--forc', '~/data'],
    ['--rec', '--fo', '~/data'],
    ['--r', '--f', '~/data'],
  ])('classifies the abbreviated delete: rm %s %s %s', (...args) => {
    const r = detectDanger('rm', args);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it.each([
    ['-rf', '~/data'],
    ['-r', '-f', '~/data'],
    ['-R', '--force', '~/data'],
    ['--recursive', '--force', '~/data'],
    ['-r', '--force', '~/data'],
  ])('still classifies the full spelling: rm %s %s %s', (...args) => {
    expect(detectDanger('rm', args).level).toBe('destructive');
  });

  it.each([
    ['sudo', ['rm', '--rec', '--force', '~/data']],
    ['env', ['rm', '--re', '--fo', '~/data']],
    ['nohup', ['rm', '--rec', '--fo', '~/data']],
  ] as const)('sees the abbreviated delete behind %s', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('destructive');
  });

  it('sees the abbreviated delete in an inline interpreter payload', () => {
    expect(detectDanger('bash', ['-c', 'rm --rec --force ~/data']).level).toBe('destructive');
  });

  it.each([['~/data'], ['--force', '~/data'], ['--recursive', '~/data'], ['--verbose', '~/data']])(
    'leaves a non-recursive-force delete safe: rm %s',
    (...args) => {
      expect(detectDanger('rm', args).level).toBe('safe');
    },
  );

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

  it('keeps the cmd.exe recursive-force shapes classified (parity)', () => {
    expect(detectDanger('rmdir', ['/s', '/q', 'dir']).level).toBe('destructive');
    expect(detectDanger('rd', ['/s', '/q', 'dir']).level).toBe('destructive');
    expect(detectDanger('del', ['/s', 'dir']).level).toBe('destructive');
    // /s alone still prompts in cmd, so it stays safe.
    expect(detectDanger('rmdir', ['/s', 'dir']).level).toBe('safe');
  });

  it('keeps the PowerShell prefix rule classified (parity)', () => {
    expect(detectDanger('remove-item', ['-rec', '-fo', 'x']).level).toBe('destructive');
  });
});
