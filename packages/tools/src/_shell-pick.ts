/**
 * Shell picker for the `bash` tool on Windows.
 *
 * Historically the bash tool always fell back to `cmd.exe` on Windows — a
 * reasonable default for the small set of POSIX-style commands the tool was
 * built around (`echo`, `dir`, `cd`, `set`, etc.). That breaks when the
 * caller emits PowerShell-style commands (e.g. Codex on Windows routinely
 * emits `Get-Content`, `Get-ChildItem`, `Set-Location`, …), which `cmd.exe`
 * rejects with "'Get-Content' is not recognized as an internal or external
 * command, operable program or batch file." This module decides — purely from
 * the command string and a few well-known env vars — which shell should run
 * the command. It returns a tagged value; bash.ts does the actual spawn.
 *
 * The picker never spawns anything itself, so it is safe to unit-test in
 * isolation. Shell *resolution* (finding the actual binary on PATH) lives in
 * `_win32-resolve.ts` and runs at spawn time.
 *
 * Selection precedence (Windows only):
 *   1. `WRONGSTACK_SHELL` env var, if it names a known shell (cmd | powershell
 *      | pwsh). This is the override for users who want a fixed shell.
 *   2. Auto-detect: if the command "looks like" PowerShell — i.e. uses cmdlet
 *      verb-noun syntax, $-variables, subexpressions, here-strings, etc. —
 *      route to PowerShell. Prefers `pwsh` (PowerShell 7+) and falls back to
 *      `powershell` (Windows PowerShell 5.1) at spawn time.
 *   3. Default: `cmd.exe` (preserves legacy behavior).
 *
 * On non-Windows the picker is a no-op — bash.ts already routes through
 * `/bin/bash -c`. We return `'cmd'` as a sentinel value that means "the
 * platform default"; bash.ts maps it to the right binary.
 */

export type BashShell = 'cmd' | 'powershell' | 'pwsh';

/** Sentinel returned on POSIX — bash.ts maps this to `/bin/bash -c`. */
export const POSIX_DEFAULT: BashShell = 'cmd';

export interface PickShellEnv {
  /** Read-only env view. Tests pass `{ get: (k) => process.env[k] }`. */
  get(key: string): string | undefined;
}

/**
 * Decide which shell should execute `command` on `platform`. Pure function —
 * no I/O, no side effects, no exceptions (invalid input returns the default).
 */
export function pickShell(
  platform: NodeJS.Platform,
  command: string,
  env: PickShellEnv,
): BashShell {
  if (platform !== 'win32') return POSIX_DEFAULT;

  // 1. Explicit override. Unknown values are ignored (the override is a
  //    safety hatch, not a free-form field — silently ignoring typos is
  //    friendlier than throwing on a config typo).
  const override = env.get('WRONGSTACK_SHELL')?.trim().toLowerCase();
  if (override === 'cmd' || override === 'cmd.exe') return 'cmd';
  if (override === 'powershell' || override === 'powershell.exe') return 'powershell';
  if (override === 'pwsh' || override === 'pwsh.exe') return 'pwsh';

  // 2. Auto-detect: command looks like PowerShell.
  if (looksLikePowerShell(command)) return 'pwsh';

  // 3. Legacy default.
  return 'cmd';
}

/**
 * Heuristic PowerShell detector. Conservative on purpose — false positives
 * route `cmd.exe` work into PowerShell (different parsing rules, different
 * exit-code semantics, sometimes very different stdout), which is more
 * disruptive than a single "command not recognized" error. We only return
 * true for patterns that are unambiguously PowerShell.
 *
 * Detected patterns:
 *   - cmdlet verb-noun syntax (`Get-`, `Set-`, `New-`, `Remove-`, `Add-`,
 *     `Clear-`, `Copy-`, `Move-`, `Rename-`, `Test-`, `Update-`, `Write-`,
 *     `Read-`, `Push-`, `Pop-`, `Invoke-`, `Start-`, `Stop-`, `Wait-`,
 *     `Out-`, `Format-`, `Group-`, `Measure-`, `Compare-`, `Resolve-`,
 *     `ConvertTo-`, `ConvertFrom-`, `Import-`, `Export-`, `Select-`,
 *     `Where-`, `ForEach-`, `Sort-`, `Tee-`, `Split-`, `Join-`, `Limit-`,
 *     `Skip-`, `Step-`, `Trace-`, `Debug-`, `Register-`, `Unregister-`,
 *     `Enable-`, `Disable-`, `Restart-`, `Suspend-`, `Resume-`, `Save-`,
 *     `Open-`, `Close-`, `Lock-`, `Unlock-`, `Mount-`, `Dismount-`,
 *     `Enter-`, `Exit-`, `Use-`, `Show-`, `Hide-`, `Find-`, `Search-`,
 *     `Watch-`, `Initialize-`, `Optimize-`, `Compress-`, `Expand-`,
 *     `Convert-`, `Merge-`, `Checkpoint-`, `Undo-`, `Redo-`, `Approve-`,
 *     `Deny-`, `Block-`, `Grant-`, `Revoke-`, `Assert-`, `Confirm-`,
 *     `Resolve-`, `Wait-`, `Receive-`, `Send-`, `Connect-`, `Disconnect-`,
 *     `Read-`, `Write-`).
 *   - $-prefixed variables (`$env:`, `$foo`, `$script:bar`, `$_`).
 *   - Subexpressions (`$(...)`).
 *   - Here-strings (`@"…"@`, `@'…'@`).
 *   - Splatting (`@(...)` at start of argument).
 *   - PowerShell-comparison operators (`-eq`, `-ne`, `-lt`, `-gt`, `-le`,
 *     `-ge`, `-like`, `-notlike`, `-match`, `-notmatch`, `-contains`,
 *     `-in`, `-and`, `-or`, `-not`, `-band`, `-bor`, `-bxor`,
 *     `-replace`, `-split`, `-join`, `-is`, `-as`, `-f`).
 *   - `.ps1` extension mentioned in the command.
 *   - `&` call operator followed by a `$`-variable (`& $cmd ...`).
 *   - Common PowerShell aliases that don't exist in cmd.exe: `gci`, `gi`,
 *     `gp`, `sl`, `cd` is ambiguous (cmd.exe has `cd` too — skip), `ls`
 *     ambiguous (cmd.exe does NOT have `ls`), `cat`, `cp`, `mv`, `rm`,
 *     `echo` (echo is in cmd too), `gcm`, `gci`, `gps`, `ps`, `select`,
 *     `where`, `?`, `%`.
 *
 *    The Windows-style path `C:\` alone is not a PowerShell tell — both
 *    shells accept it. We only flip on PS-specific syntax.
 *
 * The function is case-insensitive and tolerates leading whitespace.
 */
export function looksLikePowerShell(command: string): boolean {
  if (!command) return false;
  const trimmed = command.trimStart();

  // .ps1 file in the command → almost certainly PowerShell.
  if (/\.ps1\b/i.test(trimmed)) return true;

  // Variable reference / subexpression / here-string / splatting.
  // These four are unambiguous PowerShell syntax — no false positives in
  // any common cmd.exe or POSIX shell.
  if (/\$[\w:{]/i.test(trimmed)) return true; // $foo, $env:PATH, $script:x, $_
  if (/\$\(/.test(trimmed)) return true; // $(...)
  if (/@\s*['"]/.test(trimmed)) return true; // @'...'@ or @"..."@
  if (/&\s+\$/.test(trimmed)) return true; // & $cmd args
  if (/(^|\s)@\s*\(/.test(trimmed)) return true; // @(...) splat

  // PowerShell comparison / logical operators. The leading dash + letter
  // pattern is rare in cmd.exe scripts (cmd.exe flags are usually `/x`),
  // so `-eq`, `-like`, etc. are reliable tells. We require a word boundary
  // on each side to avoid matching inside paths like `C:\foo-eq\bar`.
  if (/(?:^|[\s\[\(\{,;])(?:-eq|-ne|-lt|-gt|-le|-ge|-like|-notlike|-match|-notmatch|-contains|-notcontains|-in|-notin|-and|-or|-not|-band|-bor|-bxor|-replace|-isplit|-join|-is|-as|-f)(?:$|[\s\]\)\},;])/i.test(trimmed)) {
    return true;
  }

  // Cmdlet verb-noun: `<Verb>-<Noun>` where Verb is one of the canonical
  // PowerShell verbs (unambiguous list above). The Verb must be followed
  // by `-` and at least one more hyphen-separated token. This avoids
  // matching unix-style single-dash flags (`-rf`, `-la`) and double-dash
  // flags (`--foo`).
  if (PS_VERB_RE.test(trimmed)) return true;

  // Common PowerShell aliases that have no cmd.exe equivalent.
  // `\b<alias>\b` at the start of a token; preceded by start-of-string or a
  // command separator so we don't fire on substrings inside longer tokens.
  //
  // Excluded aliases (too ambiguous with cmd.exe builtins / common unix
  // tools that resolve through PATHEXT on Windows):
  //   - `where` (cmd.exe `where` finds executables on PATH; PS `where` is
  //      Where-Object, a pipeline filter — totally different semantics).
  //   - `select` (cmd.exe has no `select`, but PS `select` is `Select-Object`
  //      and we don't want a stray match in scripts that pipe `dir` into
  //      something else).
  //   - `ps` (single-letter collision with too many tokens; gcm/gps cover
  //      the common Get-Process / Get-Command cases more precisely).
  if (/(?:^|[\s;&|])(gci|gi|gp|gcm|gps|sl|rm|cat|cp|mv)\b/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * The canonical PowerShell verbs (and their common variants). Used only by
 * `looksLikePowerShell` to detect `<Verb>-<Noun>` cmdlet syntax. The full
 * list is long; we cover every verb in the PowerShell 7 SDK's
 * `VerbsCommon`, `VerbsData`, `VerbsDiagnostic`, `VerbsLifecycle`,
 * `VerbsOther`, `VerbsSecurity`, and `VerbsCommunications` modules, plus the
 * most-used verbs from `VerbsApproved`.
 *
 * We list them in the regex below rather than as a Set because matching is
 * done in a single regex pass over the command string — building a Set and
 * scanning every token would be slower and harder to read.
 */
const PS_VERB_RE = new RegExp(
  // Boundaries: start-of-string, whitespace, `;`, `&`, `|`, `(`, `{`, `,`.
  '(?:^|[\\s;&|\\(\\{,])' +
    // The verb itself, followed by `-`.
    '(?:' +
      'Get|Set|New|Remove|Add|Clear|Copy|Move|Rename|Test|Update|Write|Read|Push|Pop|Invoke|Start|Stop|Wait|' +
      'Out|Format|Group|Measure|Compare|Resolve|ConvertTo|ConvertFrom|Convert|Import|Export|Select|Where|ForEach|Sort|' +
      'Tee|Split|Join|Limit|Skip|Step|Trace|Debug|Register|Unregister|Enable|Disable|Restart|Suspend|Resume|Save|' +
      'Open|Close|Lock|Unlock|Mount|Dismount|Enter|Exit|Use|Show|Hide|Find|Search|Watch|Initialize|Optimize|' +
      'Compress|Expand|Merge|Checkpoint|Undo|Redo|Approve|Deny|Block|Grant|Revoke|Assert|Confirm|Receive|Send|' +
      'Connect|Disconnect|Reset|Backup|Restore|Publish|Unpublish|Install|Uninstall|Build|Rebuild|Deploy|' +
      'Submit|Process|Complete|Approve|Revoke|Pay|Refund|Decline|Receive|Send' +
    ')-' +
    // Noun: at least one non-space, non-quote character. We require a `-`
    // after the verb, so the matched token is at minimum `Verb-X` — already
    // cmdlet-shaped. Noun chars are `[A-Za-z0-9]`; PowerShell noun tokens
    // never contain spaces or punctuation.
    '[A-Za-z][A-Za-z0-9]+(?:[\\-\\+][A-Za-z][A-Za-z0-9]+)*' +
    // Optional: followed by whitespace, end-of-string, `-` (continuation),
    // or a flag. This avoids matching only the *prefix* of a longer token
    // (e.g. `Get-Content` shouldn't fire if the next char is itself a
    // letter forming part of a longer path — but paths can't follow a
    // cmdlet verb without a space, so a trailing non-letter is sufficient).
    '(?:$|[\\s\\-\\;\\&\\|\\(\\)\\{\\},])',
  'i',
);

/**
 * Return the argv prefix for a given shell. The bash tool passes a single
 * command string and expects the shell to interpret it. cmd.exe uses
 * `/c <cmd>`; PowerShell uses `-NoLogo -NoProfile -NonInteractive -Command -`
 * and reads the script from stdin (the `-` at the end is the documented way
 * to tell PowerShell "the script is on stdin, not as an argument"). Stdin
 * pipe sidesteps the entire class of quoting bugs that arise from
 * interpolating multi-line / single-quoted / dollar-sign-laden scripts into
 * a `-Command "..."` string.
 */
export function shellArgs(shell: BashShell): string[] {
  if (shell === 'powershell' || shell === 'pwsh') {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
  }
  return ['/c'];
}