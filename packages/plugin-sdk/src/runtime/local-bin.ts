/**
 * @wrongstack/plugins — project-local binary resolution.
 *
 * Why this module exists
 * ----------------------
 * Several plugins need to run a Node CLI that ships with the project
 * (`biome`, `eslint`, `tsc`, `vitest`, …). The obvious spelling —
 * `execFile('npx', ['biome', …])` — is wrong in three separate ways:
 *
 *  1. **It does not run on Windows at all.** `npx`/`pnpm`/`npm` are
 *     `.cmd` shims there, and `execFile`/`spawn` without a shell do not
 *     consult `PATHEXT`. The call fails `ENOENT`, plugins swallow the
 *     error as "tool not installed", and the feature silently no-ops on
 *     every Windows machine.
 *  2. **It is slow.** `npx` re-resolves the package on each invocation,
 *     and for a missing package it may try to *download* one — on a hook
 *     that fires after every write.
 *  3. **It is a weaker sandbox.** The shim is a shell script; arguments
 *     cross a `cmd.exe` boundary on Windows (the BatBadBut class).
 *
 * `lint-gate` and `test-flake-detector` already solved this locally by
 * resolving the package's `bin` entry through `createRequire` and running
 * it as `process.execPath <entry>`. That is the correct pattern: no shell,
 * no shim, no network, identical on every platform. This module promotes
 * that proven approach to a shared helper so every plugin gets it.
 *
 * Fallback: when the package is genuinely absent from the project,
 * `resolveNodeBin` returns `null` and the caller decides whether to
 * degrade gracefully or fall back to a PATH lookup via
 * `resolveWin32Command` (exported here for that purpose).
 */

import { createRequire } from 'node:module';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { accessSync, constants, readFileSync } from 'node:fs';
import { buildWin32CmdShimInvocation, resolveWin32Command } from '@wrongstack/tools/win32';

export { resolveWin32Command };

/** A spawn-ready invocation, already adjusted for the host platform. */
export interface ExecInvocation {
  cmd: string;
  args: string[];
  /** Only ever true on the Windows `.cmd`/`.bat` shim path. */
  windowsVerbatimArguments: boolean;
}

/**
 * Turn a `(command, args)` pair into something `execFile`/`spawn` can
 * actually launch on this platform.
 *
 * On Windows, `npx`/`npm`/`pnpm`/`biome`/`tsc`/… ship as `.cmd` wrappers.
 * `execFile` and `spawn` without a shell ignore `PATHEXT`, so a bare
 * `execFile('npx', …)` fails `ENOENT` — and because every plugin treats a
 * spawn failure as "tool not installed", the feature silently no-ops on
 * every Windows machine. This resolves the real path first and, for a
 * `.cmd`/`.bat` shim, routes through `cmd.exe` with per-argument quoting
 * and a metacharacter guard (the BatBadBut argument-injection class), so
 * a dynamic path argument still cannot chain a second command.
 *
 * On non-Windows, and for real `.exe` binaries, this is a passthrough.
 *
 * Throws when an argument carries a `cmd.exe` metacharacter on the shim
 * path — callers should treat that as "skip", never as "run anyway".
 *
 * Prefer {@link resolveNodeBin} when the target is a Node CLI that the
 * project depends on: `node <bin-entry>` needs no shim at all.
 */
export function resolveExecInvocation(
  command: string,
  args: readonly string[] = [],
): ExecInvocation {
  const resolved = resolveWin32Command(command);
  const normalizedResolved = resolved.toLowerCase();
  const needsShell =
    process.platform === 'win32' &&
    (normalizedResolved.endsWith('.cmd') || normalizedResolved.endsWith('.bat'));
  if (needsShell) {
    const shim = buildWin32CmdShimInvocation(resolved, args);
    return { cmd: shim.command, args: shim.args, windowsVerbatimArguments: true };
  }
  return { cmd: resolved, args: [...args], windowsVerbatimArguments: false };
}

/**
 * Locate `cmd` on `PATH`, or return `null` if it is not there.
 *
 * This is the existence check `resolveWin32Command` deliberately does not
 * provide: that function returns its input unchanged when nothing matches,
 * so a caller cannot distinguish "found `biome`" from "gave up and handed
 * back the string `biome`". Treating the passthrough as success makes a
 * missing tool look installed — the caller then spawns it, gets `ENOENT`,
 * and (because plugins read a spawn failure as "not installed") silently
 * does nothing while reporting itself healthy.
 *
 * Returns the resolved path on success. Walks `PATH` directly, applying
 * `PATHEXT` suffixes on Windows for a bare name and checking the execute
 * bit on POSIX.
 */
export function findOnPath(cmd: string): string | null {
  if (!cmd) return null;
  const exists = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // An explicit path is used as-is, if it exists.
  if (cmd.includes('/') || cmd.includes('\\')) {
    return exists(cmd) ? resolve(cmd) : null;
  }

  // Which suffixes to try per PATH entry. On Windows a bare name has to be
  // probed against PATHEXT (`biome` -> `biome.cmd`); a name that already
  // carries an extension (`node.exe`) is probed as written. Deliberately
  // NOT delegating to `resolveWin32Command` here: it short-circuits on any
  // name containing an extension and returns it unchanged, which this
  // function must not mistake for a successful lookup.
  const suffixes =
    process.platform === 'win32' && extname(cmd) === ''
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const base = join(dir, cmd);
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** A resolved, directly-spawnable invocation. Never a shell or a shim. */
export interface ResolvedNodeBin {
  /** Always `process.execPath` — the Node binary running this process. */
  cmd: string;
  /** `[binEntryPath, ...extraArgs]`. */
  args: string[];
  /** Absolute path of the package's bin entry, for diagnostics. */
  entry: string;
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Cache of resolution results keyed by `packageName|binName|cwd`.
 *
 * Bounded: a long-lived session that walks many working directories must
 * not accumulate entries forever. `null` results remain cached for at most
 * the short TTL below; insertion-order eviction may remove them sooner when
 * the cache reaches `BIN_CACHE_MAX`.
 */
interface BinCacheEntry {
  value: ResolvedNodeBin | null;
  cachedAt: number;
}

const binCache = new Map<string, BinCacheEntry>();
const BIN_CACHE_MAX = 64;
const NEGATIVE_BIN_CACHE_TTL_MS = 5_000;

function cachePut(key: string, value: ResolvedNodeBin | null): ResolvedNodeBin | null {
  // Insertion-ordered eviction (oldest first) keeps this a plain LRU-ish
  // bound without the bookkeeping of a true LRU; resolution is cheap
  // enough that an occasional re-probe costs nothing.
  while (binCache.size >= BIN_CACHE_MAX) {
    const oldest = binCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    binCache.delete(oldest);
  }
  binCache.set(key, { value, cachedAt: Date.now() });
  return value;
}

/** Drop every cached resolution. Call from `teardown()`. */
export function clearLocalBinCache(): void {
  binCache.clear();
}

/**
 * Resolve a project-local Node CLI to a `process.execPath <entry>`
 * invocation.
 *
 * @param packageName npm package to resolve, e.g. `@biomejs/biome`.
 * @param binName     which `bin` key to prefer when the package declares
 *                    several. Falls back to the sole/first entry.
 * @param cwd         project root whose `package.json` anchors resolution.
 * @param extraArgs   arguments appended after the bin entry.
 *
 * Returns `null` when the package is not installed, declares no `bin`, or
 * the declared entry escapes its own package directory (a tampered
 * `package.json` must not become an arbitrary-file execution primitive).
 */
export function resolveNodeBin(
  packageName: string,
  binName: string,
  cwd: string,
  extraArgs: readonly string[] = [],
): ResolvedNodeBin | null {
  const key = `${packageName}|${binName}|${cwd}`;
  const cached = binCache.get(key);
  if (cached !== undefined) {
    if (
      cached.value !== null ||
      Date.now() - cached.cachedAt < NEGATIVE_BIN_CACHE_TTL_MS
    ) {
      return cached.value === null
        ? null
        : { ...cached.value, args: [cached.value.entry, ...extraArgs] };
    }
    binCache.delete(key);
  }

  let resolved: ResolvedNodeBin | null = null;
  try {
    const requireFromProject = createRequire(resolve(cwd, 'package.json'));
    const packagePath = requireFromProject.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : (packageJson.bin?.[binName] ?? Object.values(packageJson.bin ?? {})[0]);
    if (relativeBin && !isAbsolute(relativeBin)) {
      const packageDir = dirname(packagePath);
      const entry = resolve(packageDir, relativeBin);
      // Sandbox: the bin entry must live inside its own package.
      if (isInside(packageDir, entry)) {
        resolved = { cmd: process.execPath, args: [entry], entry };
      }
    }
  } catch {
    resolved = null;
  }

  cachePut(key, resolved);
  return resolved === null ? null : { ...resolved, args: [resolved.entry, ...extraArgs] };
}

/**
 * Resolve the first installed package from `candidates`.
 *
 * Used by plugins that accept several equivalent tools (biome *or*
 * eslint, vitest *or* jest) and want the first one the project actually
 * has, without probing each with a subprocess.
 */
export function resolveFirstNodeBin(
  candidates: readonly { packageName: string; binName: string; args?: readonly string[] }[],
  cwd: string,
): (ResolvedNodeBin & { packageName: string; binName: string }) | null {
  for (const c of candidates) {
    const hit = resolveNodeBin(c.packageName, c.binName, cwd, c.args ?? []);
    if (hit) return { ...hit, packageName: c.packageName, binName: c.binName };
  }
  return null;
}
