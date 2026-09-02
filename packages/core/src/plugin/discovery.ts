/**
 * External plugin discovery — filesystem convention for third-party plugins.
 *
 * Two roots are scanned (when present):
 *   - `~/.wrongstack/plugins/`          — user-global plugins
 *   - `<projectRoot>/.wrongstack/plugins/` — project-local plugins
 *
 * Each immediate child of a root is a candidate:
 *   - a directory named `<plugin-name>/` whose entry is resolved from
 *     `package.json` (`main` / `exports["."]`) or falls back to
 *     `index.js` / `index.mjs` / `index.cjs`,
 *   - or a single entry file (`<plugin-name>.js` / `.mjs` / `.cjs`).
 *
 * `node_modules` and dot-entries are skipped: packages installed by
 * `wstack plugin add --install` are loaded through their explicit
 * `path` config entry, not through directory discovery, so they are
 * never double-loaded. Scan order is alphabetical per root for
 * deterministic load order; roots are scanned in the order given.
 *
 * Discovery is read-only and never imports plugin code — resolving an
 * entry does not execute it. The host decides what to do with the
 * candidates (enablement, trust pinning, import).
 */

import type { Dirent } from 'node:fs';

export interface ExternalPluginCandidate {
  /** Candidate name — the directory or file basename without extension. */
  name: string;
  /** Absolute path of the resolved JavaScript entry file. */
  entryPath: string;
  /** Discovery root the candidate was found under. */
  root: string;
}

export interface SkippedPluginCandidate {
  name: string;
  root: string;
  reason: string;
}

export interface PluginDiscoveryResult {
  candidates: ExternalPluginCandidate[];
  /** Candidates that were found but could not be resolved to an entry. */
  skipped: SkippedPluginCandidate[];
}

/** Injectable filesystem access so discovery is unit-testable. */
export interface DiscoveryIo {
  readdir(root: string): Promise<Dirent[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readFile(path: string): Promise<string>;
}

export const DEFAULT_PLUGIN_DISCOVERY_IO: DiscoveryIo = {
  async readdir(root) {
    const { readdir } = await import('node:fs/promises');
    return readdir(root, { withFileTypes: true });
  },
  async stat(path) {
    const { stat } = await import('node:fs/promises');
    return stat(path);
  },
  async readFile(path) {
    const { readFile } = await import('node:fs/promises');
    return readFile(path, 'utf8');
  },
};

const ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;
const SKIP_DIR_NAMES = new Set(['node_modules']);

function isDotEntry(name: string): boolean {
  return name.startsWith('.');
}

function hasEntryExtension(name: string): boolean {
  return ENTRY_EXTENSIONS.some((ext) => name.endsWith(ext));
}

async function isFile(io: DiscoveryIo, path: string): Promise<boolean> {
  try {
    return (await io.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(io: DiscoveryIo, path: string): Promise<boolean> {
  try {
    return (await io.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface ResolvedPkgEntry {
  entry: string | undefined;
  problem: string | undefined;
}

/**
 * Resolve the entry file for a plugin directory from its `package.json`.
 * Handles both the legacy `main` field and the `exports["."]` subpath
 * (string form or conditions object — `import` preferred over `default`).
 */
async function resolvePackageEntry(io: DiscoveryIo, dir: string): Promise<ResolvedPkgEntry> {
  const pkgPath = `${dir}/package.json`;
  if (!(await isFile(io, pkgPath))) {
    return { entry: undefined, problem: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await io.readFile(pkgPath));
  } catch (err) {
    return {
      entry: undefined,
      problem: `invalid package.json (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { entry: undefined, problem: 'package.json is not an object' };
  }
  const pkg = parsed as { main?: unknown; exports?: unknown };
  // exports["."] is authoritative when present (modern packaging); main is
  // the legacy fallback.
  const candidates: string[] = [];
  const dotExport = (pkg.exports as Record<string, unknown> | undefined | null)?.['.'];
  if (typeof dotExport === 'string') {
    candidates.push(dotExport);
  } else if (dotExport !== null && typeof dotExport === 'object') {
    const conditions = dotExport as Record<string, unknown>;
    for (const key of ['import', 'module', 'default']) {
      const value = conditions[key];
      if (typeof value === 'string') candidates.push(value);
    }
  }
  if (typeof pkg.main === 'string' && pkg.main.length > 0) {
    candidates.push(pkg.main);
  }
  for (const candidate of candidates) {
    // exports-style paths are required to start with './'; main may be bare.
    const normalized = candidate.startsWith('.') ? candidate : `./${candidate}`;
    const base = `${dir}/${normalized.slice(2)}`;
    if (await isFile(io, base)) return { entry: base, problem: undefined };
    for (const ext of ENTRY_EXTENSIONS) {
      if (await isFile(io, `${base}${ext}`)) {
        return { entry: `${base}${ext}`, problem: undefined };
      }
    }
  }
  return {
    entry: undefined,
    problem:
      'package.json declares no resolvable entry (checked main, exports["."], index fallbacks)',
  };
}

/**
 * Resolve the JavaScript entry file for a plugin directory: `package.json`
 * `main`/`exports["."]` first, then `index.js`/`index.mjs`/`index.cjs`
 * probing. Returns null when no entry can be resolved. Shared by directory
 * discovery and explicit `config.plugins[].path` resolution. Paths are
 * returned with forward separators on every platform so trust pin keys and
 * import targets stay canonical.
 */
export async function resolvePluginEntryPath(
  dir: string,
  io: DiscoveryIo = DEFAULT_PLUGIN_DISCOVERY_IO,
): Promise<string | null> {
  const { entry: resolved } = await resolvePackageEntry(io, dir);
  if (resolved) return resolved;
  for (const ext of ENTRY_EXTENSIONS) {
    const candidate = `${dir}/index${ext}`;
    if (await isFile(io, candidate)) return candidate;
  }
  return null;
}

function canon(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Resolve a configured target (entry file OR directory) to its entry file.
 * Returns the input (forward-slash normalized) when it is already a file;
 * null when it is a directory without a resolvable entry or does not exist.
 */
export async function resolvePluginTarget(
  target: string,
  io: DiscoveryIo = DEFAULT_PLUGIN_DISCOVERY_IO,
): Promise<string | null> {
  if (await isFile(io, target)) return canon(target);
  if (await isDirectory(io, target)) return resolvePluginEntryPath(canon(target), io);
  return null;
}

/**
 * Scan discovery roots for external plugin candidates. Missing roots are
 * not an error — they simply contribute no candidates.
 */
export async function discoverExternalPlugins(
  roots: readonly string[],
  io: DiscoveryIo = DEFAULT_PLUGIN_DISCOVERY_IO,
): Promise<PluginDiscoveryResult> {
  const candidates: ExternalPluginCandidate[] = [];
  const skipped: SkippedPluginCandidate[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await io.readdir(root);
    } catch {
      continue; // root missing or unreadable — nothing to discover
    }
    // Alphabetical for deterministic load order across platforms.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (isDotEntry(entry.name) || SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = canon(`${root}/${entry.name}`);
      if (entry.isDirectory() || (await isDirectory(io, full))) {
        const resolved = await resolvePluginEntryPath(full, io);
        if (resolved) {
          candidates.push({ name: entry.name, entryPath: resolved, root });
        } else {
          skipped.push({
            name: entry.name,
            root,
            reason: 'no resolvable entry (package.json main/exports or index fallbacks)',
          });
        }
      } else if (entry.isFile() && hasEntryExtension(entry.name)) {
        candidates.push({
          name: entry.name.slice(0, entry.name.length - extOf(entry.name).length),
          entryPath: full,
          root,
        });
      }
    }
  }
  return { candidates, skipped };
}

function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}
