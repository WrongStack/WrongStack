import { describe, expect, it } from 'vitest';
import {
  looksLikePowerShell,
  looksLikePowerShellExtended,
  wrapPowerShellScript,
  pickShell,
  POSIX_DEFAULT,
  shellArgs,
  diagnoseBashism,
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
    expect(pickShell(win, '$text -match "pattern"', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$items -split ","', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$data -csplit ";"', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$arr -notcontains "x"', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$val -notin $list', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$val -in $list', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '$arr -contains "x"', envFrom({}))).toBe('pwsh');
  });

  it('detects .ps1 references', () => {
    expect(pickShell(win, './scripts/build.ps1 -Config Release', envFrom({}))).toBe('pwsh');
  });

  it('detects #requires directive', () => {
    expect(pickShell(win, '#requires -Version 7', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '  #requires -Modules Az', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '#requires -RunAsAdministrator', envFrom({}))).toBe('pwsh');
  });

  it('detects param() block', () => {
    expect(pickShell(win, 'param([string]$Name)', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, '  param($x, $y)', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'param(\n  [string]$Path\n)', envFrom({}))).toBe('pwsh');
  });

  it('detects splatting with @{} and @()', () => {
    expect(pickShell(win, 'Get-Process @args', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'Invoke-Command @params', envFrom({}))).toBe('pwsh');
    expect(pickShell(win, 'Test-Path @opts', envFrom({}))).toBe('pwsh');
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

  it('uses extended detection for PS flags and pipeline cmdlets', () => {
    expect(looksLikePowerShellExtended('Remove-Item foo.txt -WhatIf')).toBe(true);
    expect(looksLikePowerShellExtended('Get-Process -ErrorAction SilentlyContinue')).toBe(true);
    expect(looksLikePowerShellExtended('Get-ChildItem | Select-Object Name')).toBe(true);
    expect(looksLikePowerShellExtended('[string]$val = "test"')).toBe(true);
    expect(looksLikePowerShellExtended('Write-Host "hello"')).toBe(true);
    expect(looksLikePowerShellExtended('Get-ItemProperty HKLM:\\Software')).toBe(true);
    // Full looksLikePowerShell also picks these up via the extended pass
    expect(looksLikePowerShell('Remove-Item foo.txt -WhatIf')).toBe(true);
    // Plain commands still don't match
    expect(looksLikePowerShellExtended('echo hi')).toBe(false);
    expect(looksLikePowerShellExtended('pnpm install')).toBe(false);
  });

  it('extended detects -match, -split, -replace operators', () => {
    expect(looksLikePowerShellExtended('$text -match "pattern"')).toBe(false); // first pass catches
    expect(looksLikePowerShellExtended('$items -split ","')).toBe(false); // first pass catches
    expect(looksLikePowerShellExtended('$data -csplit ";"')).toBe(false); // first pass catches
  });

  it('directly detects -notcontains, -notin, -contains, -in collection operators', () => {
    // These are caught by the first-pass operator regex in looksLikePowerShell.
    expect(looksLikePowerShell('$arr -notcontains "x"')).toBe(true);
    expect(looksLikePowerShell('$val -notin $list')).toBe(true);
    expect(looksLikePowerShell('$val -in $list')).toBe(true);
    expect(looksLikePowerShell('$arr -contains "x"')).toBe(true);
    // Negative: substring inside a path should NOT match.
    expect(looksLikePowerShell('type C:\foo-notcontains\bar.txt')).toBe(false);
    expect(looksLikePowerShell('type C:\foo-notin\bar.txt')).toBe(false);
  });
});

describe('wrapPowerShellScript', () => {
  it('adds encoding bootstrap without a stdin BOM', () => {
    const wrapped = wrapPowerShellScript('npm run build');
    expect(wrapped.charCodeAt(0)).not.toBe(0xfeff);
    expect(wrapped.startsWith('[Console]::OutputEncoding')).toBe(true);
    expect(wrapped).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  });
  it('wraps user command with native exit code propagation', () => {
    const wrapped = wrapPowerShellScript('npm run build');
    expect(wrapped).toContain('npm run build');
    expect(wrapped).toContain('if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE }');
  });
  it('suppresses confirmations without enabling WhatIf mode', () => {
    const wrapped = wrapPowerShellScript('Remove-Item foo.txt');
    expect(wrapped).toContain("$ConfirmPreference='None'");
    expect(wrapped).toContain('$WhatIfPreference=$false');
    expect(wrapped).not.toContain('$WhatIfPreference=$true');
  });
  it('preserves multi-line scripts verbatim', () => {
    const script = '$x = 1\n$x + 2';
    const wrapped = wrapPowerShellScript(script);
    expect(wrapped).toContain(script);
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

describe('diagnoseBashism', () => {
  it('returns undefined for clean commands / empty input', () => {
    expect(diagnoseBashism('', 'pwsh')).toBeUndefined();
    expect(diagnoseBashism('Get-ChildItem -Recurse', 'pwsh')).toBeUndefined();
    expect(diagnoseBashism('git status', 'cmd')).toBeUndefined();
    expect(diagnoseBashism('node build.js && node test.js', 'pwsh')).toBeUndefined();
  });

  it('flags /dev/null with the right per-shell replacement', () => {
    expect(diagnoseBashism('foo 2>/dev/null', 'pwsh')).toContain('$null');
    expect(diagnoseBashism('foo 2>/dev/null', 'powershell')).toContain('2>$null');
    expect(diagnoseBashism('foo 2>/dev/null', 'cmd')).toContain('nul');
  });

  it('flags && only on Windows PowerShell 5.1, not pwsh 7 or cmd', () => {
    expect(diagnoseBashism('a && b', 'powershell')).toContain('&&');
    // pwsh 7 + cmd accept && — those commands succeed and never reach here, so
    // even if called, we must not flag them.
    expect(diagnoseBashism('a && b', 'pwsh')).toBeUndefined();
    expect(diagnoseBashism('a && b', 'cmd')).toBeUndefined();
  });

  it('flags export, heredoc, rm -rf, and which', () => {
    expect(diagnoseBashism('export FOO=bar', 'pwsh')).toContain('$env:NAME');
    expect(diagnoseBashism('cat <<EOF\nx\nEOF', 'pwsh')).toContain('here-string');
    expect(diagnoseBashism('rm -rf dist', 'pwsh')).toContain('Remove-Item');
    expect(diagnoseBashism('rm -rf dist', 'cmd')).toContain('rmdir');
    expect(diagnoseBashism('which node', 'pwsh')).toContain('Get-Command');
    expect(diagnoseBashism('which node', 'cmd')).toContain('where');
  });

  it('names the shell and is advisory (asks to rewrite, does not block)', () => {
    const hint = diagnoseBashism('foo 2>/dev/null', 'pwsh');
    expect(hint).toContain('PowerShell 7');
    expect(hint).toContain('Rewrite it in PowerShell syntax and retry.');
  });
});
