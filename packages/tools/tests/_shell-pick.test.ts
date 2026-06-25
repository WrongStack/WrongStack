import { describe, expect, it } from 'vitest';
import {
  looksLikePowerShell,
  pickShell,
  POSIX_DEFAULT,
  shellArgs,
  type BashShell,
} from '../src/_shell-pick.js';

const envFrom = (vars: Record<string, string>) => ({
  get: (k: string) => vars[k],
});

describe('pickShell — POSIX', () => {
  it('always returns POSIX_DEFAULT on linux', () => {
    expect(pickShell('linux', 'Get-Content file', envFrom({}))).toBe(POSIX_DEFAULT);
  });
  it('always returns POSIX_DEFAULT on darwin', () => {
    expect(pickShell('darwin', '$PSVersionTable', envFrom({}))).toBe(POSIX_DEFAULT);
  });
  it('ignores WRONGSTACK_SHELL on POSIX (POSIX keeps its own resolver path)', () => {
    // pickShell is a Windows-only helper; on POSIX the env var is
    // handled by bash.ts directly. Confirm pickShell does not second-guess.
    expect(pickShell('linux', 'echo hi', envFrom({ WRONGSTACK_SHELL: '/bin/zsh' }))).toBe(POSIX_DEFAULT);
  });
});

describe('pickShell — Windows defaults', () => {
  const win = 'win32';

  it('returns cmd when nothing PowerShell-like is detected', () => {
    expect(pickShell(win, 'echo hello', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'dir C:\\foo', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'pnpm test', envFrom({}))).toBe('cmd');
  });

  it('returns cmd for empty input (defensive — bash.ts already rejects empty commands)', () => {
    expect(pickShell(win, '', envFrom({}))).toBe('cmd');
  });
});

describe('pickShell — WRONGSTACK_SHELL override', () => {
  const win = 'win32';

  it.each<[string, BashShell]>([
    ['cmd', 'cmd'],
    ['cmd.exe', 'cmd'],
    ['CMD', 'cmd'],
    ['powershell', 'powershell'],
    ['PowerShell.exe', 'powershell'],
    ['POWERSHELL', 'powershell'],
    ['pwsh', 'pwsh'],
    ['pwsh.exe', 'pwsh'],
    ['  pwsh  ', 'pwsh'],
  ])('"%s" → %s', (override, expected) => {
    expect(pickShell(win, 'echo hi', envFrom({ WRONGSTACK_SHELL: override }))).toBe(expected);
  });

  it('ignores unknown override values (falls back to detection)', () => {
    // /bin/zsh is a POSIX shell — silently ignored on Windows so a stale
    // POSIX-derived WRONGSTACK_SHELL does not brick the tool.
    expect(pickShell(win, 'echo hi', envFrom({ WRONGSTACK_SHELL: '/bin/zsh' }))).toBe('cmd');
    expect(pickShell(win, 'Get-Content foo', envFrom({ WRONGSTACK_SHELL: '/bin/zsh' }))).toBe('pwsh');
  });

  it('override wins over auto-detect', () => {
    // Even when the command looks like PowerShell, an explicit cmd override
    // forces cmd.exe. The user knows their shell.
    expect(
      pickShell(win, 'Get-Content foo', envFrom({ WRONGSTACK_SHELL: 'cmd' })),
    ).toBe('cmd');
  });
});

describe('pickShell — auto-detect (Codex-style commands)', () => {
  const win = 'win32';

  it.each([
    'Get-Content package.json',
    'Get-ChildItem -Recurse',
    'Set-Location C:\\repos',
    'Get-Process | Where-Object {$_.CPU -gt 10}',
    'Test-Path ./foo',
    'New-Item -ItemType Directory build',
    'Copy-Item src dst -Recurse',
    'Remove-Item -Recurse -Force node_modules',
    'Write-Host "hello"',
    'Read-Host "name"',
    'Get-AzContext',
    'Invoke-RestMethod https://example.com',
    'Start-Sleep -Seconds 1',
  ])('detects "%s" as PowerShell', (cmd) => {
    expect(pickShell(win, cmd, envFrom({}))).toBe('pwsh');
  });

  it('detects PowerShell aliases (cat/rm/cp/mv/gci/gps/etc.)', () => {
    expect(pickShell(win, 'cat file.txt', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'rm -rf build', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'cp -r src dst', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'gci -Recurse', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'gps', envFrom({}))).toBe('pwsh');
  });

  it('detects PowerShell variable / subexpression syntax', () => {
    expect(pickShell(win, '$env:PATH', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'echo $foo', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'Write-Host $_', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'Get-Date $(Get-Date)', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '& $myScript args', envFrom({}))).toBe('pwsh');
  });

  it('detects PowerShell comparison operators', () => {
    expect(pickShell(win, '$x -eq 5', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$names -like "A*"', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$a -and $b', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$path -replace "foo", "bar"', envFrom({}))).toBe('pwsh');
  });

  it('detects .ps1 references', () => {
    expect(pickShell(win, './scripts/build.ps1 -Config Release', envFrom({}))).toBe('pwsh');
  });

  it('does NOT flag plain cmd.exe commands as PowerShell', () => {
    // Important: false positives route cmd.exe work to PowerShell, which
    // breaks PATH lookups, environment, and exit-code semantics.
    expect(pickShell(win, 'echo hello', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'dir', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'pnpm install', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'node script.js', envFrom({}))).toBe('cmd');
    expect(pickShell(win, 'git status', envFrom({}))).toBe('cmd');
    // Windows path that happens to contain `-eq` should NOT trip the detector
    // (path-component boundary required by the operator regex).
    expect(pickShell(win, 'type C:\\foo-eq\\bar.txt', envFrom({}))).toBe('cmd');
  });

  it('does NOT match the standalone `where` (ambiguous between cmd and PS)', () => {
    // cmd.exe `where` finds executables on PATH; PS `where` is Where-Object.
    // Routing it to PS would silently change semantics, so we leave it to cmd.
    expect(pickShell(win, 'where python', envFrom({}))).toBe('cmd');
  });

  it('handles leading whitespace', () => {
    expect(pickShell(win, '   Get-Content foo', envFrom({}))).toBe('pwsh');
  });
});

describe('looksLikePowerShell — unit-level', () => {
  it('returns false for empty input', () => {
    expect(looksLikePowerShell('')).toBe(false);
  });
  it('returns false for plain POSIX-style commands', () => {
    expect(looksLikePowerShell('echo hi')).toBe(false);
    expect(looksLikePowerShell('ls -la')).toBe(false);
  });
});

describe('shellArgs', () => {
  it('returns cmd-style argv for cmd', () => {
    expect(shellArgs('cmd')).toEqual(['/c']);
  });
  it('returns PowerShell argv with stdin-flag `-` for both editions', () => {
    expect(shellArgs('powershell')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '-',
    ]);
    expect(shellArgs('pwsh')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '-',
    ]);
  });
});