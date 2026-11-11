/**
 * Trust-on-first-use (TOFU) pinning for external plugins.
 *
 * In-process plugins run with full host privileges, so the only practical
 * supply-chain signal available before plugin code executes is "has this
 * plugin's entry file changed since the user first ran it?". On first load
 * the host records a SHA-256 of the resolved entry file in
 * `~/.wrongstack/plugin-trust.json`. Later loads compare hashes:
 *
 *   - match            → plugin loads silently
 *   - no pin yet       → pin is written now, plugin loads (first use)
 *   - hash mismatch    → plugin is REFUSED until the user re-pins it with
 *                        `wstack plugin trust <name>`
 *
 * The pin covers the plugin's local source closure (entry file plus the
 * relative modules it imports) — it catches swapped/updated plugin builds
 * and tampered local helpers, not deep transitive package changes.
 * It is a tamper signal, not a signature scheme.
 *
 * Disable entirely with `features.pluginsTrust: false`. `'required'`
 * fail-closes every downgrade path (unresolvable, unreadable, and unpinnable
 * entries refuse the plugin); `'advisory'` degrades refusals — including
 * changed hashes — to warnings. Default (`true`/`'tofu'`) is
 * trust-on-first-use with changed-hash refusal.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/contracts/types/errors';
import { withFileLock } from '../utils/atomic-write.js';

export interface PluginTrustEntry {
  /** Absolute entry file path that was hashed at pin time. */
  entry: string;
  /** Bare hex sha256 digest of the entry file contents at pin time (same format as hashPluginClosure). */
  integrity: string;
  /** ISO timestamp of when the pin was written. */
  pinnedAt: string;
  /** Optional provenance — the config spec/path the plugin was loaded from. */
  spec?: string | undefined;
}

export interface PluginTrustStore {
  pinned: Record<string, PluginTrustEntry>;
}

export type PluginTrustVerification =
  | { status: 'unpinned'; integrity: string }
  | { status: 'trusted'; integrity: string }
  | { status: 'changed'; expected: string; actual: string; pinnedAt: string };

/** Default trust store location: `~/.wrongstack/plugin-trust.json`. */
export function defaultPluginTrustPath(globalRoot: string): string {
  return join(globalRoot, 'plugin-trust.json');
}

/**
 * Canonical pin-key form: forward slashes on every platform, so a plugin
 * pinned by discovery (forward-slash paths) and re-pinned from a config
 * entry (backslashes on Windows) addresses the same store key.
 */
export function normalizeTrustKey(path: string): string {
  return path.replaceAll('\\', '/');
}

export async function hashFileContents(
  entryPath: string,
  readFileFn: (path: string) => Promise<Buffer> = defaultReadFile,
): Promise<string> {
  const contents = await readFileFn(entryPath);
  // Bare hex — must match hashPluginDirectoryClosure's single-file digest format
  // so a plugin pinned via one access shape still verifies when loaded via the other.
  return createHash('sha256').update(contents).digest('hex');
}

const CLOSURE_HASH_LIMIT = 2000;
const CLOSURE_FILE_LIMIT = 16 * 1024 * 1024; // 16 MiB per file

/** Extensions probed when a local import omits one. */
const LOCAL_RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * TypeScript "NodeNext" import style: the specifier carries the *output*
 * extension (`./helper.js`) while the file on disk is the source (`.ts`).
 * Without this mapping the helper resolves to nothing and its content is
 * never hashed — a changed helper would keep the old pin valid.
 */
const JS_EXTENSION_TO_SOURCE: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Matches relative (local) module specifiers in ESM/CJS source text:
 * `import ... from './x'`, `export ... from './x'`, `import './x'`,
 * `import('./x')` and `require('./x')`.
 */
const LOCAL_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\1/g;

/** Collect the distinct relative specifiers referenced by a source file. */
function extractLocalImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  LOCAL_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = LOCAL_SPECIFIER_RE.exec(source);
  while (match !== null) {
    found.add(match[2] ?? '');
    match = LOCAL_SPECIFIER_RE.exec(source);
  }
  found.delete('');
  return [...found];
}

/** Resolve a relative specifier to an existing file, or undefined. */
async function resolveLocalImport(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  for (const ext of LOCAL_RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    const st = await stat(candidate).catch(() => undefined);
    if (st?.isFile()) return candidate;
  }
  // TypeScript source with a NodeNext-style specifier: `./helper.js` on disk
  // is `helper.ts`. Probe the source extension so the helper is hashed.
  const dot = base.lastIndexOf('.');
  if (dot > base.lastIndexOf(sep)) {
    const mapped = JS_EXTENSION_TO_SOURCE[base.slice(dot).toLowerCase()];
    if (mapped) {
      const stem = base.slice(0, dot);
      for (const ext of mapped) {
        const candidate = stem + ext;
        const st = await stat(candidate).catch(() => undefined);
        if (st?.isFile()) return candidate;
      }
    }
  }
  for (const ext of LOCAL_RESOLVE_EXTENSIONS) {
    if (ext === '') continue;
    const candidate = join(base, `index${ext}`);
    const st = await stat(candidate).catch(() => undefined);
    if (st?.isFile()) return candidate;
  }
  return undefined;
}

/**
 * Digest for a single-file plugin that lives directly in a shared discovery
 * root: the entry file plus the local (relative) modules it imports,
 * transitively. Sibling plugins in the same root are NOT included, so
 * unrelated plugins never taint each other's pins — but a helper the
 * plugin actually imports IS, so editing it invalidates the pin.
 */
async function hashLocalImportClosure(entryPath: string, rootDir: string): Promise<string> {
  const visited = new Set<string>();
  const manifest: string[] = [];
  const queue: string[] = [entryPath];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let bytes: Buffer;
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > CLOSURE_FILE_LIMIT) continue;
      bytes = await readFile(file);
    } catch {
      continue;
    }
    const rel = relative(rootDir, file).split(sep).join('/');
    const sha = createHash('sha256').update(bytes).digest('hex');
    manifest.push(`${rel}\0${bytes.length}\0${sha}`);
    for (const specifier of extractLocalImportSpecifiers(bytes.toString('utf8'))) {
      const resolved = await resolveLocalImport(file, specifier);
      if (resolved) {
        queue.push(resolved);
        continue;
      }
      // Unresolvable local import: record the specifier so adding/removing
      // the file still changes the digest.
      const relMissing = relative(rootDir, resolve(dirname(file), specifier))
        .split(sep)
        .join('/');
      manifest.push(`${relMissing}\0-1\0unresolved`);
    }
  }
  if (visited.size === 1 && manifest.length === 1) {
    // No local imports at all — keep the legacy single-file digest so
    // existing pins for dependency-free plugins stay valid.
    return hashFileContents(entryPath);
  }
  manifest.sort();
  return createHash('sha256').update(manifest.join('\n')).digest('hex');
}

/**
 * Traverse the local (relative) import closure of `entryPath`.
 *
 * Returns every file reachable through relative imports (the entry included).
 */
async function collectLocalImportClosure(entryPath: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const visited = new Set<string>();
  const queue: string[] = [entryPath];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let bytes: Buffer;
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > CLOSURE_FILE_LIMIT) continue;
      bytes = await readFile(file);
    } catch {
      continue;
    }
    files.set(file, bytes);
    for (const specifier of extractLocalImportSpecifiers(bytes.toString('utf8'))) {
      const resolved = await resolveLocalImport(file, specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
  return files;
}

/** True when `file` sits under `root` (or is `root` itself). */
function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Local dependencies that a plugin imports from OUTSIDE its own directory
 * (e.g. `foo/index.ts` importing `../shared/util.ts`).
 *
 * The directory manifest only covers files inside the plugin directory, so
 * these helpers are executed code that the pin must cover too — otherwise a
 * rewritten helper keeps the old pin valid.
 */
async function collectExternalLocalDependencies(
  entryPath: string,
  dir: string,
): Promise<Map<string, Buffer>> {
  const external = new Map<string, Buffer>();
  const files = await collectLocalImportClosure(entryPath);
  for (const [file, bytes] of files) {
    if (isInside(dir, file)) continue;
    if (file.split(/[\\/]/).includes('node_modules')) continue;
    external.set(file, bytes);
  }
  return external;
}

/**
 * Compute a deterministic integrity digest covering a plugin's source closure:
 * - When `rawEntryPath` sits directly inside one of `discoveryRoots` (a shared
 *   single-file plugins folder such as `~/.wrongstack/plugins/foo.ts`), hashes
 *   the entry file plus the local (relative) modules it imports, transitively,
 *   so editing an imported helper invalidates the pin while sibling plugins
 *   in the same root stay independent.
 * - When `rawEntryPath` lives in its own plugin directory (`foo/index.ts`),
 *   hashes a sorted Merkle manifest (`relpath\0size\0sha256`) of all files in
 *   the directory (skipping `node_modules` and dot-directories) so editing a
 *   helper `.ts`/`.js` file is caught by TOFU verification. Local imports
 *   that reach outside the plugin directory are added to the same manifest.
 */
export async function hashPluginDirectoryClosure(
  rawEntryPath: string,
  discoveryRoots?: readonly string[] | undefined,
): Promise<string> {
  const entryPath = resolve(rawEntryPath);
  const dir = dirname(entryPath);
  if (discoveryRoots?.some((root) => normalizeTrustKey(dir) === normalizeTrustKey(resolve(root)))) {
    return hashLocalImportClosure(entryPath, dir);
  }
  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(dir);
  } catch {
    return hashFileContents(entryPath);
  }
  if (!dirStat.isDirectory()) return hashFileContents(entryPath);
  const entryBase = basename(entryPath);
  const files: string[] = [];
  async function walk(d: string): Promise<void> {
    if (files.length > CLOSURE_HASH_LIMIT) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = d + sep + e.name;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  files.sort();
  const manifest: string[] = [];
  for (const full of files) {
    const rel = relative(dir, full).split(sep).join('/');
    let bytes: Buffer;
    try {
      const st = await stat(full);
      if (!st.isFile() || st.size > CLOSURE_FILE_LIMIT) continue;
      bytes = await readFile(full);
    } catch {
      continue;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    manifest.push(`${rel}\0${bytes.length}\0${sha}`);
  }
  if (!manifest.some((line) => line.startsWith(`${entryBase}\0`))) {
    const entryBytes = await readFile(entryPath);
    const entrySha = createHash('sha256').update(entryBytes).digest('hex');
    manifest.push(`${entryBase}\0${entryBytes.length}\0${entrySha}`);
  }
  // Local dependencies outside the plugin directory are part of the executed
  // code — they belong in the digest, keyed by their path relative to the
  // plugin directory so the manifest stays deterministic.
  const external = await collectExternalLocalDependencies(entryPath, dir);
  for (const [full, bytes] of external) {
    const rel = relative(dir, full).split(sep).join('/');
    const sha = createHash('sha256').update(bytes).digest('hex');
    manifest.push(`${rel}\0${bytes.length}\0${sha}`);
  }
  manifest.sort();
  return createHash('sha256').update(manifest.join('\n')).digest('hex');
}

export const hashPluginClosure = hashPluginDirectoryClosure;

async function defaultReadFile(path: string): Promise<Buffer> {
  return readFile(path);
}

/**
 * Read the trust store. A missing file is an empty store (first run).
 * A corrupt file is a hard error — silently ignoring it would downgrade
 * every existing pin to "unpinned" and re-trust changed code, which is
 * exactly the attack this file exists to catch.
 */
export async function readPluginTrustStore(
  storePath: string,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<PluginTrustStore> {
  let raw: string;
  try {
    raw = await readFileFn(storePath);
  } catch (err) {
    // Only a missing file is an empty store. Any other read error (EBUSY from
    // an AV scan, EPERM, EIO) used to look empty too, and the next pin wrote
    // that empty store back — deleting every existing pin.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { pinned: {} };
    throw new FsError({
      message: `Plugin trust store "${storePath}" could not be read (${err instanceof Error ? err.message : String(err)})`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FsError({
      message: `Plugin trust store "${storePath}" is not valid JSON — fix or delete the file before loading external plugins (${err instanceof Error ? err.message : String(err)})`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FsError({
      message: `Plugin trust store "${storePath}" has an unexpected shape (expected { pinned: {...} }) — fix or delete the file`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  const pinned = (parsed as { pinned?: unknown }).pinned;
  if (pinned === undefined) return { pinned: {} };
  if (pinned === null || typeof pinned !== 'object' || Array.isArray(pinned)) {
    throw new FsError({
      message: `Plugin trust store "${storePath}" has an invalid "pinned" section — fix or delete the file`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  return { pinned: pinned as Record<string, PluginTrustEntry> };
}

/**
 * Write the trust store atomically (temp file + rename, 0o600 — it is a
 * security-relevant record, same treatment as the profile config).
 */
export async function writePluginTrustStore(
  storePath: string,
  store: PluginTrustStore,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, storePath);
}

/**
 * Pure verification: compare a freshly computed integrity hash against the
 * pinned entry. Keyed by plugin name; the pinned `entry` path is advisory
 * (an npm update can legitimately move the entry inside node_modules while
 * the content hash is what decides trust).
 */
export function verifyPluginTrust(
  name: string,
  integrity: string,
  store: PluginTrustStore,
): PluginTrustVerification {
  const key = normalizeTrustKey(name);
  const pinned = Object.hasOwn(store.pinned, key) ? store.pinned[key] : undefined;
  if (!pinned) return { status: 'unpinned', integrity };
  if (pinned.integrity === integrity) return { status: 'trusted', integrity };
  return {
    status: 'changed',
    expected: pinned.integrity,
    actual: integrity,
    pinnedAt: pinned.pinnedAt,
  };
}

/** Insert or replace the pin for `name` and persist the store. */
export async function pinPluginTrust(
  storePath: string,
  name: string,
  entry: string,
  integrity: string,
  spec?: string,
): Promise<PluginTrustStore> {
  const key = normalizeTrustKey(name);
  // Locked read-modify-write: two pins at once (two sessions booting with new
  // plugins) both read the old store and the later write dropped the other pin.
  return withFileLock(storePath, async () => {
    const store = await readPluginTrustStore(storePath);
    store.pinned[key] = { entry, integrity, pinnedAt: new Date().toISOString(), spec };
    await writePluginTrustStore(storePath, store);
    return store;
  });
}

/** Remove the pin for `name` (if present) and persist the store. */
export async function unpinPluginTrust(storePath: string, name: string): Promise<PluginTrustStore> {
  const key = normalizeTrustKey(name);
  return withFileLock(storePath, async () => {
    const store = await readPluginTrustStore(storePath);
    if (Object.hasOwn(store.pinned, key) && store.pinned[key] !== undefined) {
      delete store.pinned[key];
      await writePluginTrustStore(storePath, store);
    }
    return store;
  });
}
