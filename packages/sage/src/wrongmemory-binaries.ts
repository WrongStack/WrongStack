/**
 * Where the WrongMemory executables are, for starting the daemon and for the
 * MCP bridge command line.
 *
 * Search order, first hit wins:
 *  1. `Sage.service.daemonPath` (the CLI is looked up next to it);
 *  2. `WRONGMEMORYD_PATH` (likewise);
 *  3. the standard per-user install, `%LOCALAPPDATA%\WrongMemory\bin`, which
 *     `wrongmemory install` and `wstack sage service install` write;
 *  4. next to the running executable (a bundled layout);
 *  5. `PATH`.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export type WrongMemoryBinaryKind = 'daemon' | 'cli';

export type WrongMemoryBinarySource = 'config' | 'env' | 'installed' | 'bundled' | 'path';

export interface WrongMemoryBinary {
  path: string;
  source: WrongMemoryBinarySource;
}

export interface WrongMemoryBinaryLookup {
  daemonPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  exists?: (file: string) => boolean;
}

export function wrongMemoryExecutableName(
  kind: WrongMemoryBinaryKind,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = kind === 'daemon' ? 'wrongmemoryd' : 'wrongmemory';
  return platform === 'win32' ? `${base}.exe` : base;
}

/** The standard per-user install directory (`wrongmemory install`'s default prefix). */
export function wrongMemoryInstallDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined;
  const local = env.LOCALAPPDATA;
  return local ? path.join(local, 'WrongMemory', 'bin') : undefined;
}

/** Locate a WrongMemory executable, or `undefined` when none is found. */
export function findWrongMemoryBinary(
  kind: WrongMemoryBinaryKind,
  lookup: WrongMemoryBinaryLookup = {},
): WrongMemoryBinary | undefined {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const exists = lookup.exists ?? existsSync;
  const name = wrongMemoryExecutableName(kind, platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const candidates: Array<[string | undefined, WrongMemoryBinarySource]> = [];
  const pinned = (file: string | undefined, source: WrongMemoryBinarySource) => {
    if (!file) return;
    candidates.push([kind === 'daemon' ? file : pathApi.join(pathApi.dirname(file), name), source]);
  };
  pinned(lookup.daemonPath, 'config');
  pinned(env.WRONGMEMORYD_PATH, 'env');
  const installDir = wrongMemoryInstallDir(env, platform);
  if (installDir) candidates.push([pathApi.join(installDir, name), 'installed']);
  candidates.push([
    pathApi.join(pathApi.dirname(lookup.execPath ?? process.execPath), name),
    'bundled',
  ]);
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (dir.trim()) candidates.push([pathApi.join(dir.trim(), name), 'path']);
  }
  for (const [file, source] of candidates) {
    if (file && exists(file)) return { path: file, source };
  }
  return undefined;
}

/** `install.json` written by `wrongmemory install` next to the binaries, if any. */
export function readWrongMemoryInstallManifest(
  binDir: string,
): { version?: string | undefined } | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(binDir, 'install.json'), 'utf8')) as {
      version?: unknown;
    };
    return { version: typeof raw.version === 'string' ? raw.version : undefined };
  } catch {
    return undefined;
  }
}
