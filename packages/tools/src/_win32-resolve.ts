import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * On Windows, Node.js `spawn()` without a shell does NOT resolve .cmd/.bat
 * extensions through PATHEXT — it only auto-resolves .exe. Most Node.js CLI
 * tools (npx, pnpm, biome, tsc, vitest, etc.) ship as .cmd wrappers on
 * Windows. This function resolves the command name to its full path so spawn
 * can find it without relying on shell-mode argument concatenation.
 *
 * On non-Windows, returns the command unchanged.
 */
export function resolveWin32Command(cmd: string): string {
  if (process.platform !== 'win32') return cmd;

  // Already has a path or extension — use as-is
  // Normalize forward slashes so path.extname correctly detects extensions
  // even when a Unix-style path is passed on Windows.
  if (cmd.includes('/') || cmd.includes('\\') || path.extname(cmd.replace(/\//g, '\\'))) {
    return cmd;
  }

  const pathext = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC')
    .toLowerCase()
    .split(';');

  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);

  for (const dir of pathDirs) {
    const base = path.join(dir, cmd);
    // Check extensions in PATHEXT order. .EXE should win first because
    // it's typically listed first, and .exe doesn't need shell: true.
    for (const ext of pathext) {
      const full = `${base}${ext}`;
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // Not found with this extension — try next
      }
    }
  }

  // Not found — return original; let spawn report ENOENT with the
  // expected error message so tools can surface it properly.
  return cmd;
}

/**
 * Resolve a PowerShell binary by name. `pickShell` in `_shell-pick.ts`
 * already decides whether the user wants `'pwsh'` (PowerShell 7+) or
 * `'powershell'` (Windows PowerShell 5.1). This helper turns that decision
 * into a real on-disk path.
 *
 * Order:
 *   1. If `cmd` is `pwsh` and a `pwsh.exe` exists on PATH → return that.
 *   2. If `cmd` is `pwsh` and only `powershell.exe` exists → fall back to
 *      that (the alternative is a cryptic ENOENT for the user).
 *   3. Symmetric for `powershell`: prefer `powershell.exe`, fall back to
 *      `pwsh.exe` if installed and the legacy binary is missing.
 *   4. Anything else → delegate to `resolveWin32Command` (handles `.cmd`
 *      shims a sysadmin might drop in place, etc.).
 *
 * Returns the original command on ENOENT — `spawn()` will surface a clean
 * ENOENT and the user sees "PowerShell not installed", which is the right
 * diagnostic. We never throw from here.
 */
export function resolvePowerShell(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  const lower = cmd.toLowerCase();
  if (lower !== 'pwsh' && lower !== 'powershell' && lower !== 'pwsh.exe' && lower !== 'powershell.exe') {
    return resolveWin32Command(cmd);
  }
  // Prefer the requested edition, fall back to the other one.
  const primary = lower.startsWith('pwsh') ? 'pwsh.exe' : 'powershell.exe';
  const fallback = lower.startsWith('pwsh') ? 'powershell.exe' : 'pwsh.exe';
  const resolved = resolveWin32Command(primary);
  if (resolved !== primary) {
    // resolveWin32Command returns the original string when not found.
    const fb = resolveWin32Command(fallback);
    return fb === fallback ? cmd : fb;
  }
  return resolved;
}

/**
 * cmd.exe metacharacters that chain a new command or redirect I/O. When a
 * `.cmd`/`.bat` wrapper is spawned with `shell: true` + `windowsVerbatimArguments:
 * true`, Node passes argv through to `cmd.exe /c` UNQUOTED — so an argument
 * carrying one of these can break out of the intended command line and run an
 * attacker-chosen command (the CVE-2024-27980 / "BatBadBut" argument-injection
 * class). We deliberately opt out of Node's auto-quoting (verbatim) for correct
 * path handling, so this guard restores the protection.
 *
 * The set is limited to the unambiguous command-separator / redirection chars
 * plus newlines and NUL. Legitimate package-manager / test-runner flags and
 * Windows file paths (which use `:` `\` `/` `.` `-` `_` space `(` `)`) never
 * contain these, so the guard is false-positive-free. `^ % !` are intentionally
 * excluded: alone they only escape or expand — they cannot start a new command
 * without one of the separators below, all of which are rejected.
 */
const WIN32_SHELL_META = /[&|<>\r\n\0]/;

/**
 * Throw if any argument contains a cmd.exe command-injection metacharacter.
 * Call this ONLY on the Windows `.cmd`/`.bat` + verbatim spawn path (where the
 * args reach the shell unquoted). A no-op for safe args.
 */
export function assertSafeWin32ShellArgs(args: readonly unknown[]): void {
  for (const a of args) {
    if (typeof a === 'string' && WIN32_SHELL_META.test(a)) {
      throw new Error(
        'win32 shell spawn: argument contains a shell metacharacter ' +
          '(one of & | < > or a newline) that could enable command injection ' +
          'through the .cmd/.bat wrapper — refusing to run. Offending argument: ' +
          JSON.stringify(a),
      );
    }
  }
}
