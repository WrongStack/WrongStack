import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { buildChildEnv, buildWin32CmdShimInvocation } from '@wrongstack/core/utils';
import type { ServerConfig } from '../types.js';

/**
 * Spawn a language server.
 *
 * On Windows a `.cmd`/`.bat` shim cannot be spawned without a shell
 * (CVE-2024-27980), and the obvious workaround — `spawn(cmd, args, { shell: true })`
 * — is the BatBadBut hazard (DEP0190): Node joins `args` into the command line
 * *after* the quoting decision, so `&`, `|`, `<`, `>` and `%VAR%` inside an
 * argument start a second program. This module previously quoted only the
 * command and passed `args` through with `shell: true`, which left that hole
 * open (WS-SEC-11).
 *
 * `buildWin32CmdShimInvocation` is the repo's single source for the safe
 * construction — an explicit `cmd.exe /d /c call "<cmd>" "<arg>" …` with
 * `windowsVerbatimArguments` and an outright refusal of metacharacters. Every
 * other spawn site already used it; this one is now wired to it too.
 */
export function safeSpawn(cfg: ServerConfig, cwd: string): ChildProcessWithoutNullStreams {
  const env = buildChildEnv({ extra: cfg.env });
  const stdio = ['pipe', 'pipe', 'pipe'] as const;
  if (shouldUseShell(cfg.command, process.platform)) {
    const shim = buildWin32CmdShimInvocation(cfg.command, serverArgs(cfg.args));
    return spawn(shim.command, shim.args, {
      cwd,
      env,
      stdio: [...stdio],
      windowsVerbatimArguments: shim.windowsVerbatimArguments,
      windowsHide: true,
    });
  }
  return spawn(cfg.command, serverArgs(cfg.args), {
    cwd,
    env,
    stdio: [...stdio],
    windowsHide: true,
  });
}

function shouldUseShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function serverArgs(args: string[] | undefined): string[] {
  return args ?? [];
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const safeSpawnCoverage = { serverArgs, shouldUseShell };
