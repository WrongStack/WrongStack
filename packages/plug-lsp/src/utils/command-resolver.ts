import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';

type ProbeProcess = {
  kill(): unknown;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
};
type SpawnProbe = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'ignore'; windowsHide: true },
) => ProbeProcess;

export async function resolveServerCommand(command: string, cwd: string): Promise<string | null> {
  const local = await findLocalBinary(cwd, command);
  if (local) return local;
  return (await commandExistsOnPath(command)) ? command : null;
}

export async function findLocalBinary(cwd: string, command: string): Promise<string | null> {
  if (path.isAbsolute(command)) return (await fileExists(command)) ? path.normalize(command) : null;
  let dir = path.resolve(cwd);
  for (;;) {
    const binDir = path.join(dir, 'node_modules', '.bin');
    for (const candidate of commandCandidates(command)) {
      const full = path.join(binDir, candidate);
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function commandExistsOnPath(command: string, timeoutMs = 2000): Promise<boolean> {
  return commandProbe(command, timeoutMs, process.platform, spawn as unknown as SpawnProbe);
}

function commandProbe(
  command: string,
  timeoutMs: number,
  platform: NodeJS.Platform,
  spawnProbe: SpawnProbe,
): Promise<boolean> {
  const probe = platform === 'win32' ? 'where.exe' : 'sh';
  const args = platform === 'win32' ? [command] : ['-lc', `command -v ${shellQuote(command)}`];
  return new Promise((resolve) => {
    const child = spawnProbe(probe, args, {
      env: buildChildEnv(),
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function commandCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return [command];
  const ext = path.extname(command).toLowerCase();
  if (ext) return [command];
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command, `${command}.ps1`];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const commandResolverCoverage = {
  commandCandidates,
  commandProbe,
  fileExists,
  shellQuote,
};
