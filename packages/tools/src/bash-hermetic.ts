/**
 * `bash` hermetic mode: run a command without the user's shell startup files
 * and with a small, fixed environment, so its result does not depend on the
 * user's shell setup or on tooling variables the parent happened to export.
 *
 * The regular child env (`buildChildEnv`) already drops credentials and
 * arbitrary variables but forwards tooling prefixes (`NODE_*`, `NPM_*`,
 * `PNPM_*`, `GIT_*`, `CI*`, `XDG_*`) and `SHELL`/`TERM`. Startup files that
 * run even for a non-interactive `-c`: zsh's `.zshenv`, fish's
 * `config.fish`, and cmd.exe's AutoRun registry commands.
 */

/**
 * Variables a hermetic child keeps: enough to find programs, a home, a temp
 * dir, a locale and (on Windows) the system. Everything else is dropped.
 */
const HERMETIC_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows: programs and the shell itself fail without these.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  // WrongStack's own session tag and the configured commit identity.
  'WRONGSTACK_SESSION_ID',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]);

/** Reduce an (already credential-filtered) child env to the fixed hermetic set. */
export function hermeticEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // Windows env names are case-insensitive (`Path`, `SystemRoot`).
    if (value !== undefined && HERMETIC_KEYS.has(key.toUpperCase())) out[key] = value;
  }
  // No colour codes or pager/terminal tricks in captured output.
  out['TERM'] = 'dumb';
  return out;
}

/**
 * The `-c` argv for a POSIX shell with its startup files switched off. `sh`
 * and `dash` read startup files only when interactive (or via `ENV`, which
 * hermetic env does not carry), so they need no flag.
 */
export function hermeticPosixArgv(shellBin: string): string[] {
  const name = (shellBin.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (name === 'bash') return ['--noprofile', '--norc', '-c'];
  if (name === 'zsh') return ['-f', '-c'];
  if (name === 'fish') return ['--no-config', '-c'];
  return ['-c'];
}
