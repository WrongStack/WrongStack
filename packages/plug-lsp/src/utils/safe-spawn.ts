import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core/utils';
import type { ServerConfig } from '../types.js';

export function safeSpawn(cfg: ServerConfig, cwd: string): ChildProcessWithoutNullStreams {
  const shell = shouldUseShell(cfg.command, process.platform);
  return spawn(cfg.command, serverArgs(cfg.args), {
    cwd,
    env: buildChildEnv({ extra: cfg.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
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
