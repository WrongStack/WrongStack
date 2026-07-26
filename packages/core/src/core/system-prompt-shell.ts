/** Canonical shell the `bash` tool targets — drives the Environment Shell line
 *  and the syntax-guidance sub-block. */
export type EffectiveShell = 'pwsh' | 'powershell' | 'cmd' | 'posix';

/**
 * Derive the shell the `bash` tool will use from `os.platform()` + the pinned
 * `WRONGSTACK_SHELL` value (set at boot by `ensureSessionShell` in
 * @wrongstack/tools). On POSIX this is always `'posix'` and the caller shows the
 * raw `$SHELL`. On Windows with no pinned value (boot didn't run — tests /
 * embeddings) we report `'cmd'`, matching `bash.ts`'s default for
 * non-PowerShell-looking commands.
 */
export function effectiveShell(
  platform: NodeJS.Platform,
  wrongstackShell: string | undefined,
): EffectiveShell {
  if (platform !== 'win32') return 'posix';
  const v = wrongstackShell?.trim().toLowerCase();
  if (v === 'powershell' || v === 'powershell.exe') return 'powershell';
  if (v === 'pwsh' || v === 'pwsh.exe') return 'pwsh';
  if (v === 'cmd' || v === 'cmd.exe') return 'cmd';
  return 'cmd';
}

export const SHELL_DISPLAY: Record<Exclude<EffectiveShell, 'posix'>, string> = {
  pwsh: 'pwsh (PowerShell 7+) — write PowerShell syntax, not bash',
  powershell: 'powershell (Windows PowerShell 5.1) — write PowerShell syntax, not bash',
  cmd: 'cmd.exe (Command Prompt) — write cmd syntax, not bash',
};

/**
 * Shell-specific syntax guidance for the Environment block. Returns `''` for
 * POSIX (the model writes bash natively, so no nudge is needed). `detail:
 * 'short'` is the light-tier one-liner; `'full'` is the complete cheat-sheet.
 * The `&&`/`||` note branches on the PowerShell edition (only pwsh 7 supports
 * them).
 */
export function shellGuidanceBlock(shell: EffectiveShell, detail: 'full' | 'short'): string {
  if (shell === 'posix') return '';
  if (shell === 'cmd') {
    if (detail === 'short') {
      return '- Shell syntax: cmd.exe — use `%VAR%`, `2>nul`, `dir`/`type`/`del`/`where` (NOT bash `$VAR`, `/dev/null`, `ls`/`cat`/`rm`).';
    }
    return [
      '## Shell — cmd.exe',
      'The `bash` tool runs **cmd.exe** on this machine. Write cmd syntax, not bash/POSIX:',
      '- Env vars: `%NAME%` (NOT `$NAME`); set with `set NAME=value`.',
      '- Discard output: `2>nul` / `>nul` (NOT `2>/dev/null`).',
      '- No `ls`/`cat`/`rm`/`which`/`head` — use `dir`/`type`/`del`/`where` and `more`.',
      '- Chain with `&&` / `||` / `&`. Prefer the dedicated read/grep/glob tools over shell file ops.',
    ].join('\n');
  }
  // pwsh or powershell
  if (detail === 'short') {
    return '- Shell syntax: PowerShell — use `$env:VAR`, `2>$null`, `Get-Content`/`Select-Object` (NOT bash `$VAR`, `/dev/null`, `cat`/`head`).';
  }
  const chain =
    shell === 'pwsh'
      ? '- Chain with `&&` / `||` (supported in PowerShell 7).'
      : '- `&&` / `||` are NOT available in Windows PowerShell 5.1 — separate commands with `;` (and check `$LASTEXITCODE`).';
  return [
    `## Shell — PowerShell${shell === 'pwsh' ? ' 7+ (pwsh)' : ' 5.1 (powershell)'}`,
    'The `bash` tool runs **PowerShell** on this machine. Write PowerShell syntax, not bash/POSIX:',
    "- Env vars: read `$env:NAME`, set `$env:NAME = 'value'` (NOT `$NAME`, `%NAME%`, or `export`).",
    '- Discard output: `... 2>$null` or `$null = ...` (NOT `2>/dev/null`).',
    '- No bash builtins — use cmdlets: `head -n N`→`Select-Object -First N`, `tail`→`-Last N`, `cat`→`Get-Content`, `which x`→`Get-Command x`, `rm -rf p`→`Remove-Item -Recurse -Force p`, `touch f`→`New-Item -ItemType File f`. Prefer the grep/glob tools over `Select-String`.',
    '- Read a line window of a file: `Get-Content path | Select-Object -Skip N -First M` (the `sed -n` / `head|tail` equivalent).',
    '- Pipes work normally; `rg`/`git`/`node` and other native exes run as-is — only the *shell builtins* differ. (`rg --files src | rg pattern` is fine.)',
    '- Call exes whose path has spaces via the call operator: `& "C:\\Program Files\\app.exe" args`.',
    "- Multi-line literals: single-quoted here-string `@'…'@` with the closing `'@` at column 0.",
    '- Non-interactive only: no `Read-Host`/`Get-Credential`/`pause`; add `-Confirm:$false` to destructive cmdlets.',
    chain,
  ].join('\n');
}
