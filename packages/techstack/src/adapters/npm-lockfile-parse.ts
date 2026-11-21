import { readFile, stat } from 'node:fs/promises';

/** Strip pnpm's peer-dependency suffix: `19.1.0(react@19.1.0)` → `19.1.0`. */
function stripPeerSuffix(version: string): string {
  const paren = version.indexOf('(');
  return (paren === -1 ? version : version.slice(0, paren)).trim();
}

/**
 * Extract the resolved versions pnpm recorded for EVERY importer (workspace),
 * keyed by importer path.
 *
 * pnpm's `importers:` section maps each workspace to the exact version it
 * resolved for every declared dependency — which is precisely the per-workspace
 * question this adapter asks, and it stays correct when two workspaces pin
 * different versions of the same package. Collecting all importers in one pass
 * (instead of one targeted scan per workspace) is what lets the lockfile be
 * parsed once and shared across every workspace in a monorepo inventory run.
 *
 * Line-based on purpose: the lockfile is machine-generated with a stable
 * 2-space indent, and pulling in a YAML parser for four fields isn't worth the
 * dependency.
 *
 * ```yaml
 * importers:
 *   packages/cli:            # 2 spaces — importer
 *     dependencies:          # 4 spaces — section
 *       react:               # 6 spaces — package
 *         specifier: ^19.0.0 # 8 spaces — fields
 *         version: 19.1.0
 * ```
 */
function parsePnpmImporters(lockContent: string): Map<string, Map<string, string>> {
  const importers = new Map<string, Map<string, string>>();
  const lines = lockContent.split(/\r?\n/);

  let inImporters = false;
  let currentImporter: string | undefined;
  let currentVersions: Map<string, string> | undefined;
  let currentPackage: string | undefined;
  // pnpm 8 (lockfile v6) writes a single-project lockfile without `importers:`:
  // the root's dependency sections are top-level keys, two levels shallower.
  const rootSections = !/^importers:/m.test(lockContent);
  let offset = 0;

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    // Top-level key ends the importers block.
    if (!/^\s/.test(raw)) {
      if (inImporters && offset === 0) break;
      inImporters = raw.startsWith('importers:');
      offset = 0;
      if (rootSections && /^(?:dependencies|devDependencies|optionalDependencies):/.test(raw)) {
        inImporters = true;
        offset = 4;
        currentImporter = '.';
        currentVersions = importers.get('.') ?? new Map<string, string>();
        importers.set('.', currentVersions);
        currentPackage = undefined;
      }
      continue;
    }
    if (!inImporters) continue;

    const indent = raw.length - raw.trimStart().length + offset;
    const line = raw.trim();

    if (indent === 2) {
      // New importer — `packages/cli:` or `.:`
      const key = line.endsWith(':') ? unquote(line.slice(0, -1)) : undefined;
      if (key === undefined) {
        currentImporter = undefined;
        currentVersions = undefined;
      } else {
        currentImporter = key;
        currentVersions = new Map<string, string>();
        importers.set(currentImporter, currentVersions);
      }
      currentPackage = undefined;
      continue;
    }
    if (!currentImporter || currentVersions === undefined) continue;

    if (indent === 4) {
      currentPackage = undefined; // dependencies: / devDependencies: / …
      continue;
    }
    if (indent === 6 && line.endsWith(':')) {
      currentPackage = unquote(line.slice(0, -1));
      continue;
    }
    if (indent >= 8 && currentPackage && line.startsWith('version:')) {
      const version = stripPeerSuffix(unquote(line.slice('version:'.length).trim()));
      // `link:../core` is a workspace link, not a released version — recording
      // it as `locked` would make a local package look like a registry one.
      if (version && !version.startsWith('link:') && !version.startsWith('file:')) {
        currentVersions.set(currentPackage, version);
      }
      currentPackage = undefined;
    }
  }

  return importers;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * A `link:`/`file:`/`workspace:`/`portal:` version is a reference to a LOCAL
 * package, not a released version. The sibling pnpm/yarn/bun parsers all refuse
 * to record one; npm did not, so a local `file:` dependency was recorded as the
 * resolved version `file:../x` (and, through the empty clean-version, as a
 * fabricated `pkg:npm/<name>` registry instance).
 */
function isLocalSpec(value: string): boolean {
  return /^(?:link|file|workspace|portal):/.test(value);
}

/**
 * Parse package-lock.json (npm) to extract resolved versions.
 */
export function parseNpmLockVersions(lockContent: string): {
  versions: Map<string, string[]>;
  /** Install path (`node_modules/b`, `node_modules/a/node_modules/b`) → version. */
  installed: Map<string, string>;
  /** Install paths that are symlinks to a local package (`link: true`): workspaces. */
  links: Set<string>;
  /**
   * Install path segment → the package it really installs.
   *
   * An npm alias (`"typescript5": "npm:typescript@5.9.3"`) installs the REAL
   * package under the ALIAS name: the lockfile entry is
   * `node_modules/typescript5` and carries `"name": "typescript"`. Without
   * this map the alias name is taken for the package name, and the inventory
   * reports `pkg:npm/typescript5@5.9.3` - a package that does not exist.
   */
  aliases: Map<string, string>;
} {
  const versions = new Map<string, string[]>();
  const installed = new Map<string, string>();
  const links = new Set<string>();
  const aliases = new Map<string, string>();
  /** Record one instance, ignoring duplicates of the same name+version. */
  const record = (name: string, version: string): void => {
    const existing = versions.get(name);
    if (!existing) {
      versions.set(name, [version]);
      return;
    }
    if (!existing.includes(version)) existing.push(version);
  };

  try {
    const lock = JSON.parse(lockContent);
    // npm v1/v2: lock.dependencies, a RECURSIVE map keyed by package name.
    // A dependency that could not be hoisted (a version conflict, or anything
    // beneath one) appears only under its parent's own `dependencies`, so
    // walking the top level alone dropped those instances from `versions`.
    // The adapter's `includeTransitive` pass reports every instance precisely
    // because OSV is queried per purl — a nested `c@2.0.0` that only exists
    // there was silently unaudited while the hoisted `c@1.0.0` was reported.
    // Iterative so a hostile/deep lockfile cannot exhaust the stack.
    const pendingDependencyMaps: unknown[] = [lock.dependencies];
    while (pendingDependencyMaps.length > 0) {
      const level = pendingDependencyMaps.pop();
      if (!level || typeof level !== 'object' || Array.isArray(level)) continue;
      for (const [name, info] of Object.entries(level)) {
        if (!info || typeof info !== 'object') continue;
        const depInfo = info as { version?: unknown; dependencies?: unknown };
        if (depInfo.dependencies !== undefined) pendingDependencyMaps.push(depInfo.dependencies);
        if (typeof depInfo.version !== 'string' || isLocalSpec(depInfo.version)) continue;
        // Strip version prefixes like ^, ~, >= (an all-non-digit value strips
        // to empty and is not a version either).
        const cleanVersion = depInfo.version.replace(/^[^0-9]+/, '');
        if (cleanVersion) record(name, cleanVersion);
        // npm v1 spelled an alias in the version (`npm:typescript@5.9.3`).
        const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(depInfo.version);
        if (alias?.[1] && alias[1] !== name) aliases.set(name, alias[1]);
      }
    }
    // npm v2 (lockfileVersion 2+): lock.packages. Its keys are INSTALL PATHS,
    // not names: the root project is keyed "" and a deduped/conflicting
    // transitive install is keyed "node_modules/a/node_modules/b" (this repo's
    // own website/package-lock.json carries an empty root key and 18 such
    // nested keys). Take the segment after the LAST node_modules/ and skip
    // keys without one, so the root entry never becomes an empty-named
    // dependency and an install path never becomes a package name.
    const packages = lock.packages ?? {};
    for (const key of Object.keys(packages)) {
      const pkgInfo = packages[key] as { version?: string; link?: boolean; name?: string };
      const marker = key.lastIndexOf('node_modules/');
      if (pkgInfo.link === true && marker >= 0) links.add(key);
      // A `link: true` install (a `file:` dep or a workspace) points at a LOCAL
      // package: its `version` is a local spec or the linked package's own
      // version, never a registry release.
      if (pkgInfo.link === true || !pkgInfo.version || marker < 0) continue;
      if (isLocalSpec(pkgInfo.version)) continue;
      const name = key.slice(marker + 'node_modules/'.length);
      if (!name) continue;
      // The entry's `name` is the package it really installs. For an alias it
      // differs from the install path segment.
      const declared =
        typeof pkgInfo.name === 'string' && pkgInfo.name.length > 0 ? pkgInfo.name : undefined;
      if (declared && declared !== name) aliases.set(name, declared);
      record(name, pkgInfo.version);
      installed.set(key, pkgInfo.version);
    }
  } catch {
    // Malformed lockfile — return empty map
  }
  return { versions, installed, links, aliases };
}

/** Name and range of a yarn lock key spec (`minimist@^1.2.0`, `@a/b@npm:^2`). */
function splitYarnSpec(spec: string): { name: string; range: string } | undefined {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), range: spec.slice(at + 1).replace(/^npm:/, '') };
}

/**
 * Parse yarn.lock — classic v1 (`version "1.2.3"`) and berry (`version: 1.2.3`).
 * Each block header lists the specs it resolves (`"a@^1", a@~1.2:`), so the
 * direct dependency `a: ^1` resolves through `specs.get('a@^1')`.
 */
export function parseYarnLockVersions(lockContent: string): {
  versions: Map<string, string[]>;
  specs: Map<string, string>;
  /** `name@range` specs that resolve to a local package (a workspace, link, portal). */
  linked: Set<string>;
} {
  const versions = new Map<string, string[]>();
  const specs = new Map<string, string>();
  const linked = new Set<string>();
  let current: Array<{ name: string; range: string }> = [];
  for (const line of lockContent.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line) && line.trimEnd().endsWith(':')) {
      current = line
        .trimEnd()
        .slice(0, -1)
        .split(',')
        .map((spec) => splitYarnSpec(spec.trim().replace(/^"|"$/g, '')))
        .filter((spec): spec is { name: string; range: string } => spec !== undefined);
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line)?.[1];
    if (!version || current.length === 0) continue;
    // One block is one resolution. When a sibling workspace satisfies a plain
    // range, berry files both under it (`"lodash@npm:4.17.20,
    // lodash@workspace:packages/lodash"`, version 0.0.0-use.local): every spec
    // of that block is the local package, not an npm release.
    if (current.some(({ range }) => /^(?:workspace|link|portal|file):/.test(range))) {
      for (const { name, range } of current) linked.add(`${name}@${range}`);
      current = [];
      continue;
    }
    for (const { name, range } of current) {
      // berry lists the project's own workspaces (`app@workspace:.`, version
      // `0.0.0-use.local`) and local links beside registry packages.
      if (/^(?:workspace|link|portal|file):/.test(range)) continue;
      specs.set(`${name}@${range}`, version);
      const existing = versions.get(name);
      if (!existing) versions.set(name, [version]);
      else if (!existing.includes(version)) existing.push(version);
    }
    current = [];
  }
  return { versions, specs, linked };
}

/**
 * Parse bun's text lockfile (`bun.lock`, JSON with trailing commas). Its
 * `packages` map is keyed by install path (`minimist`, `parent/minimist`);
 * the first array element is `name@version`.
 */
export function parseBunLockVersions(lockContent: string): {
  versions: Map<string, string[]>;
  hoisted: Map<string, string>;
  /** Top-level install keys bun links to a local package (`x@workspace:packages/x`). */
  linked: Set<string>;
} {
  const versions = new Map<string, string[]>();
  const hoisted = new Map<string, string>();
  const linked = new Set<string>();
  try {
    const lock = JSON.parse(lockContent.replace(/,(\s*[}\]])/g, '$1')) as {
      packages?: Record<string, unknown>;
    };
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const ident = Array.isArray(entry) ? entry[0] : undefined;
      if (typeof ident !== 'string') continue;
      const spec = splitYarnSpec(ident);
      const topLevelKey = key.startsWith('@') ? key.split('/').length === 2 : !key.includes('/');
      // A sibling workspace satisfying a plain range is installed as
      // `["lodash@workspace:packages/lodash"]`: the local package, no release.
      if (spec && topLevelKey && /^(?:workspace|link|file|portal):/.test(spec.range)) {
        linked.add(key);
        continue;
      }
      if (!spec || !/^\d/.test(spec.range)) continue;
      const existing = versions.get(spec.name);
      if (!existing) versions.set(spec.name, [spec.range]);
      else if (!existing.includes(spec.range)) existing.push(spec.range);
      // Keyed by top-level install path, which is the manifest key: an alias
      // (`"isnum6": ["is-number@6.0.0", …]`) installs under its alias, and the
      // direct row looks it up by that key.
      if (topLevelKey) hoisted.set(key, spec.range);
    }
  } catch {
    // Malformed lockfile — return empty maps
  }
  return { versions, hoisted, linked };
}

function parsePnpmAllVersions(lockContent: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  let inPackages = false;
  for (const raw of lockContent.split(/\r?\n/)) {
    // Blank lines and comments are not top-level keys. Skipping them BEFORE the
    // section test matters: a real pnpm lockfile puts a blank line directly
    // after `packages:` (and between entries), so without this guard the flag
    // reset on that blank, the section closed before its first entry, and
    // `allVersions` came back empty — dropping EVERY transitive instance from
    // the SBOM while direct rows kept resolving, which made the two
    // includeTransitive modes return an identical count. `parsePnpmImporters`
    // has always carried this guard.
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inPackages = raw.startsWith('packages:') || raw.startsWith('snapshots:');
      continue;
    }
    if (!inPackages) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent !== 2) continue;
    const trimmed = raw.trim();
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    // v6 keys carry a leading slash: `/react@18.2.0`.
    const key = unquote(trimmed.slice(0, separator)).replace(/^\//, '');
    const clean = stripPeerSuffix(key);
    const splitAt = clean.lastIndexOf('@');
    if (splitAt <= 0) continue;
    const name = clean.slice(0, splitAt);
    const version = clean.slice(splitAt + 1);
    if (!name || !/^\d/.test(version)) continue;
    // A package legitimately appears at several versions — pnpm writes one
    // `name@version` key per instance (this repo's own lock: fs-extra ×12,
    // minimatch ×8). Keeping only the first per NAME hid every other instance
    // from the inventory, and OSV is queried per purl.
    const existing = versions.get(name);
    if (!existing) versions.set(name, [version]);
    else if (!existing.includes(version)) existing.push(version);
  }
  return versions;
}

/**
 * Parsed pnpm lockfile, shared across every workspace governed by the file.
 * `importers` maps each workspace path to its resolved direct versions;
 * `allVersions` holds every `name@version` instance in the file.
 */
interface PnpmLockParse {
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly allVersions: ReadonlyMap<string, readonly string[]>;
}

/**
 * Lockfile parses memoised per (path, mtimeMs, size).
 *
 * A pnpm monorepo has ONE lockfile governing every workspace: without this
 * cache, `inventory()` re-reads and re-parses the whole lockfile for every
 * workspace (this repository: 368 KB × 24 workspaces per run — measured in
 * PERF_LOG.md, 2026-09-26 techstack round). The stat guard keeps a hit honest
 * across `pnpm install` runs; the capacity cap bounds memory in long-lived
 * server processes that scan many projects.
 */
const PNPM_LOCK_CACHE_CAPACITY = 4;

const pnpmLockCache = new Map<string, { mtimeMs: number; size: number; parse: PnpmLockParse }>();

/**
 * pnpm that manages its own version (`packageManager`) writes the lockfile as
 * two YAML documents: an env document (`importers: .: packageManagerDependencies:
 * pnpm`, `packages: @pnpm/exe.*`) and then the project lockfile. The importer
 * parser stops after the first `importers:` block, so it read pnpm's own entry
 * and every project dependency came out unlocked. Keep the last document that
 * declares importers — the project's.
 */
function projectLockDocument(content: string): string {
  const documents = content.split(/^---[ \t]*\r?$/m);
  if (documents.length < 2) return content;
  const withImporters = documents.filter((doc) => /^importers:/m.test(doc));
  return withImporters.at(-1) ?? content;
}

export async function loadPnpmLockParse(path: string): Promise<PnpmLockParse | undefined> {
  let mtimeMs: number;
  let size: number;
  try {
    const stats = await stat(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    return undefined;
  }
  const cached = pnpmLockCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Refresh recency so the eviction below is LRU, not insertion order.
    pnpmLockCache.delete(path);
    pnpmLockCache.set(path, cached);
    return cached.parse;
  }
  try {
    const content = projectLockDocument(await readFile(path, 'utf-8'));
    const parse: PnpmLockParse = {
      importers: parsePnpmImporters(content),
      allVersions: parsePnpmAllVersions(content),
    };
    pnpmLockCache.delete(path);
    pnpmLockCache.set(path, { mtimeMs, size, parse });
    if (pnpmLockCache.size > PNPM_LOCK_CACHE_CAPACITY) {
      const oldest = pnpmLockCache.keys().next().value;
      if (oldest !== undefined) pnpmLockCache.delete(oldest);
    }
    return parse;
  } catch {
    return undefined;
  }
}
