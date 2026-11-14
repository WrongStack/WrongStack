import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/**
 * Absolute path of a real Bun binary for spawning Bun subcommands
 * (`run`, `install`, `pm pack`, `--version`).
 *
 * `process.execPath` is not enough: under `bun --bun` on Windows it is Bun's
 * `%TEMP%\bun-node-<hash>\node.exe` shim, which behaves as Node — it reads
 * `run`/`install`/`pm` as a script path ("Module not found …\run") and rejects
 * `--version` ("Missing script to execute"). Under plain Node it is `node`,
 * which has no such subcommands at all.
 *
 * Resolution: Bun's own `Bun.which('bun')` (the shim directory ships a real
 * `bun.exe` next to the `node.exe` shim), then `npm_execpath` when it names a
 * Bun binary, then the first `bun` on PATH, then `process.execPath`.
 */
export function resolveBunExecutable(env = process.env) {
  const bun = /** @type {{ which?: (name: string) => string | null } | undefined} */ (
    globalThis.Bun
  );
  const viaBun = bun?.which?.('bun');
  if (viaBun) return viaBun;

  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /^bunx?(\.exe)?$/i.test(basename(npmExecPath)) && existsSync(npmExecPath)) {
    return npmExecPath;
  }

  const names = process.platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return process.execPath;
}

/**
 * Whether an executable must be launched through a Windows shell. npm's global
 * `bun` install is a `bun.cmd` shim, and spawning a batch file without a shell
 * is refused outright: `spawnSync` reports `EINVAL` with a null exit status, so
 * the child never ran and the caller sees an unexplained failure.
 */
export function isBatchShim(executable) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable ?? '');
}

/**
 * Quote one token for the `shell: true` spawn path, which does no escaping of
 * its own. Only tokens that need it are wrapped, so an argv list the caller
 * already built (plain script names, `run`, `--filter`, a package specifier)
 * is passed through untouched and stays recognisable to the child.
 */
function quoteShellToken(token) {
  const value = String(token);
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * Spawn parts for `executable args`, switched to the shell only when the
 * executable is a batch shim. Returns `{ command, args, options }` to spread
 * into `spawnSync`/`execFileSync`; a real binary keeps the bare argv form it
 * had before, and a shim keeps the same command/argv values with only the
 * tokens that need it quoted, plus `{ shell: true }`.
 */
export function bunSpawnInvocation(executable, args = []) {
  if (!isBatchShim(executable)) return { command: executable, args: [...args], options: {} };
  return {
    command: quoteShellToken(executable),
    args: args.map(quoteShellToken),
    options: { shell: true, windowsHide: true },
  };
}
