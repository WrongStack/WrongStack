/**
 * Standalone-binary awareness.
 *
 * WrongStack also ships as a single `bun build --compile` executable per
 * platform. Two things every package assumes about a normal install stop
 * holding there, and each has one answer in this module:
 *
 * 1. **"Am I the main module?" guards lie.** Every bundled module shares one
 *    `import.meta.url` — the executable's virtual path — and `process.argv[1]`
 *    is that same virtual path. A guard comparing the two is true for EVERY
 *    module in the binary (on POSIX; Windows is only saved by slash
 *    direction), so a library module that auto-starts a server when "run
 *    directly" would start inside every CLI invocation. Guards must consult
 *    {@link isStandaloneBinary} and stand down.
 *
 * 2. **Daemon entry files do not exist on disk.** Project daemons are spawned
 *    as `process.execPath <dist/…/project-server.js>`. In the binary there is
 *    no such file and `process.execPath` is the binary itself, so each daemon
 *    is reached through the hidden `__wstack_daemon <name>` dispatch the binary
 *    entry implements. Resolvers return a {@link standaloneDaemonUrl} instead
 *    of a `file:` URL, and spawn sites turn either kind into argv with
 *    {@link daemonSpawnArgs}.
 *
 * 3. **Package assets are not beside the code.** Prompts, instructions, skills,
 *    design kits, tree-sitter grammars and the built frontends are located
 *    relative to `import.meta.url` or a resolved `package.json`. The binary
 *    embeds them as one pack and extracts it once per build under
 *    `~/.wrongstack/runtime/`; {@link standalonePackageDir} and
 *    {@link moduleDirFor} point those lookups at the extracted tree, laid out
 *    as `<root>/<package>/…` with the package's own relative structure intact.
 *
 * 4. **Re-launching the CLI** is `process.execPath <cli/dist/index.js> …` in an
 *    install and `process.execPath …` in the CLI binary: {@link cliSpawnArgs}.
 *    Another executable on this bootstrap (the desktop engine) is not the CLI
 *    and starts the installed one instead: {@link standaloneMain},
 *    {@link installedCliExecutable}.
 *
 * 5. **Running a project's own JS tool** (eslint, vitest, a bump script) as
 *    `process.execPath <bin.js>` would hand the script path to the CLI. The
 *    binary routes `__wstack_run_script <bin.js> …` to a child of itself with
 *    `BUN_BE_BUN=1` — Bun's switch that makes a compiled executable behave as
 *    plain `bun` — so the variable never leaks into our own daemon spawns:
 *    {@link scriptSpawnArgs}.
 */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Hidden first argument the binary entry routes to a daemon main. */
export const STANDALONE_DAEMON_ARG = '__wstack_daemon';

/** Hidden first argument the binary entry routes to "run this JS file as bun". */
export const STANDALONE_SCRIPT_ARG = '__wstack_run_script';

/** URL scheme a resolver returns for a daemon embedded in the binary. */
export const STANDALONE_DAEMON_PROTOCOL = 'wrongstack-daemon:';

export type StandaloneDaemonName =
  | 'chronicle'
  | 'mailbox'
  | 'session-catalog'
  | 'governance'
  | 'kanban'
  | 'sage'
  | 'codebase-index';

/**
 * Bun's virtual filesystem root for compiled executables:
 * `B:/~BUN/root/<name>` on Windows, `/$bunfs/root/<name>` on POSIX.
 */
const BUNFS_ENTRY = /^(?:[A-Za-z]:[\\/]~BUN[\\/]|\/\$bunfs\/)/;

/** True when running inside a `bun build --compile` WrongStack executable. */
export function isStandaloneBinary(entry: string | undefined = process.argv[1]): boolean {
  return (
    typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' &&
    typeof entry === 'string' &&
    BUNFS_ENTRY.test(entry)
  );
}

export function standaloneDaemonUrl(name: StandaloneDaemonName): URL {
  return new URL(`${STANDALONE_DAEMON_PROTOCOL}${name}`);
}

/** What a standalone executable's main entry is, as its entry declares to the bootstrap. */
export type StandaloneMain = 'cli' | 'engine';

const BUILD_KEY = Symbol.for('wrongstack.standalone-build');

/**
 * The main entry of the standalone executable this process runs in, or
 * undefined outside one. `'cli'` is the WrongStack CLI, so `process.execPath
 * <subcommand>` runs its subcommands (`mcp serve`, `tools`). The desktop engine
 * is built on the same bootstrap with another main and takes none: what needs
 * the CLI there must start the installed one ({@link installedCliExecutable}).
 */
export function standaloneMain(
  entry: string | undefined = process.argv[1],
): StandaloneMain | undefined {
  if (!isStandaloneBinary(entry)) return undefined;
  const build = (globalThis as Record<symbol, { main?: unknown } | undefined>)[BUILD_KEY];
  // An executable built before the stamp was declared had only the CLI as its main.
  return build?.main === 'engine' ? 'engine' : 'cli';
}

/**
 * argv (after `process.execPath`) that launches the daemon `entry` points at:
 * the script path for a built `file:` entry, the hidden dispatch for an
 * embedded one.
 */
export function daemonSpawnArgs(entry: URL, args: readonly string[]): string[] {
  if (entry.protocol === STANDALONE_DAEMON_PROTOCOL) {
    return [STANDALONE_DAEMON_ARG, entry.pathname, ...args];
  }
  return [fileURLToPath(entry), ...args];
}

/**
 * Build identity of the running executable, for daemon build-id handshakes:
 * one binary is both client and daemon, so a replaced binary (self-update)
 * must read as a different build. Size + mtime, not a content hash — hashing
 * a ~100 MB executable on every handshake is not worth it.
 */
export function standaloneBinaryBuildId(): string {
  try {
    const stat = statSync(process.execPath);
    return `standalone:${stat.size.toString(36)}:${Math.trunc(stat.mtimeMs).toString(36)}`;
  } catch {
    return 'standalone:unknown';
  }
}

const ASSET_ROOT_KEY = Symbol.for('wrongstack.standalone-assets');

/**
 * Root of the extracted asset tree, stamped by the binary entry before any
 * WrongStack module loads. Null outside the binary (or if extraction failed —
 * callers then fall back to their normal lookup and degrade as they would in
 * a broken install).
 */
export function standaloneAssetRoot(): string | null {
  if (!isStandaloneBinary()) return null;
  const root = (globalThis as Record<symbol, unknown>)[ASSET_ROOT_KEY];
  return typeof root === 'string' && path.isAbsolute(root) ? root : null;
}

/** `@wrongstack/core` → `<assetRoot>/core` in the binary; null elsewhere. */
export function standalonePackageDir(packageName: string): string | null {
  const root = standaloneAssetRoot();
  if (root === null) return null;
  if (!/^@wrongstack\/[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    throw new Error(`Invalid WrongStack package name for standalone assets: ${packageName}`);
  }
  return path.join(root, packageName.replace(/^@wrongstack\//, ''));
}

/**
 * `<package>/package.json` for asset lookups that anchor on the package root:
 * the extracted copy in the binary, `resolve(<name>/package.json)` elsewhere.
 */
export function wrongstackPackageJsonPath(
  packageName: string,
  resolve: (id: string) => string,
): string {
  const packageDir = standalonePackageDir(packageName);
  return packageDir === null
    ? resolve(`${packageName}/package.json`)
    : path.join(packageDir, 'package.json');
}

/**
 * Directory a module's relative asset lookups start from: the module's own
 * directory in an install, `<assetRoot>/<package>/dist` in the binary — so a
 * `../instructions` or `./wasm/` candidate resolves the same in both.
 */
export function moduleDirFor(moduleUrl: string, packageName: string): string {
  const packageDir = standalonePackageDir(packageName);
  return packageDir === null
    ? path.dirname(fileURLToPath(moduleUrl))
    : path.join(packageDir, 'dist');
}

/** {@link moduleDirFor} as a URL, for `new URL('./x', base)` lookups. */
export function moduleUrlFor(moduleUrl: string, packageName: string): string {
  const packageDir = standalonePackageDir(packageName);
  return packageDir === null
    ? moduleUrl
    : pathToFileURL(path.join(packageDir, 'dist', 'index.js')).href;
}

/**
 * argv (after `process.execPath`) that re-launches the WrongStack CLI:
 * the resolved CLI entry script in an install, nothing in the CLI binary.
 * In another standalone executable `process.execPath` is not the CLI
 * (`standaloneMain`), so this does not apply there.
 */
export function cliSpawnArgs(cliEntry: string, args: readonly string[]): string[] {
  return isStandaloneBinary() ? [...args] : [cliEntry, ...args];
}

/**
 * The WrongStack CLI the installer put in `<global root>/bin`, for a process
 * that is not the CLI itself; undefined when it is not installed there.
 */
export function installedCliExecutable(globalRoot: string): string | undefined {
  const file = path.join(globalRoot, 'bin', process.platform === 'win32' ? 'wstack.exe' : 'wstack');
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * argv (after `process.execPath`) that runs a JS file the way `node <file>`
 * would: directly in an install, through the script dispatch in the binary.
 */
export function scriptSpawnArgs(entry: string, args: readonly string[]): string[] {
  return isStandaloneBinary() ? [STANDALONE_SCRIPT_ARG, entry, ...args] : [entry, ...args];
}
