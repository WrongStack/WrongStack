/**
 * TechStack — npm ecosystem adapter.
 *
 * Parses package.json manifests and pnpm-lock.yaml (or package-lock.json /
 * yarn.lock) to produce DependencyObservation[] for Node.js workspaces.
 *
 * Supports: pnpm, npm, yarn, bun — determined by lockfile presence.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier A
 */

import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { buildPurl } from '../registry/purl.js';
import type {
  DependencyObservation,
  DependencyScope,
  DependencyStatus,
  EcosystemId,
  Evidence,
  Workspace,
} from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { lockfileEvidence, manifestEvidence, resolveIn, workspaceRoot } from './paths.js';

// ── Lockfile types ───────────────────────────────────────────────────────

type LockfileKind = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none';

interface LockfileInfo {
  readonly kind: LockfileKind;
  readonly path: string;
}

// ── package.json shape ───────────────────────────────────────────────────

interface PackageJsonDeps {
  readonly [packageName: string]: string;
}

interface PackageJson {
  readonly name?: string | undefined;
  readonly dependencies?: PackageJsonDeps | undefined;
  readonly devDependencies?: PackageJsonDeps | undefined;
  readonly peerDependencies?: PackageJsonDeps | undefined;
  readonly optionalDependencies?: PackageJsonDeps | undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Locate the lockfile that governs a workspace.
 *
 * Walks up from the workspace to `stopAt` (the project root). In a pnpm or npm
 * workspace only the repo root holds a lockfile — `packages/cli` has none — so
 * looking only in the workspace directory finds nothing for every package but
 * the root, and every dependency ends up with no resolved version.
 */
async function detectLockfile(workspaceDir: string, stopAt?: string): Promise<LockfileInfo> {
  const candidates: Array<{ file: string; kind: LockfileKind }> = [
    { file: 'pnpm-lock.yaml', kind: 'pnpm' },
    { file: 'package-lock.json', kind: 'npm' },
    { file: 'yarn.lock', kind: 'yarn' },
    { file: 'bun.lockb', kind: 'bun' },
  ];

  const ceiling = stopAt ? resolve(stopAt) : undefined;
  let dir = resolve(workspaceDir);

  for (;;) {
    for (const c of candidates) {
      const candidate = join(dir, c.file);
      try {
        await access(candidate);
        return { kind: c.kind, path: candidate };
      } catch {
        /* absent */
      }
    }
    if (ceiling && dir === ceiling) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    // Without a ceiling, don't wander above the workspace at all.
    if (!ceiling) break;
    dir = parent;
  }
  return { kind: 'none', path: '' };
}

/** Strip pnpm's peer-dependency suffix: `19.1.0(react@19.1.0)` → `19.1.0`. */
function stripPeerSuffix(version: string): string {
  const paren = version.indexOf('(');
  return (paren === -1 ? version : version.slice(0, paren)).trim();
}

/**
 * Extract the resolved versions pnpm recorded for one importer (workspace).
 *
 * pnpm's `importers:` section maps each workspace to the exact version it
 * resolved for every declared dependency — which is precisely the per-workspace
 * question this adapter asks, and it stays correct when two workspaces pin
 * different versions of the same package.
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
function parsePnpmImporterVersions(lockContent: string, importerPath: string): Map<string, string> {
  const versions = new Map<string, string>();
  const lines = lockContent.split(/\r?\n/);

  let inImporters = false;
  let inTargetImporter = false;
  let currentPackage: string | undefined;

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    // Top-level key ends the importers block.
    if (!/^\s/.test(raw)) {
      if (inImporters) break;
      inImporters = raw.startsWith('importers:');
      continue;
    }
    if (!inImporters) continue;

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 2) {
      // New importer — `packages/cli:` or `.:`
      const key = line.endsWith(':') ? unquote(line.slice(0, -1)) : undefined;
      inTargetImporter = key === importerPath;
      currentPackage = undefined;
      continue;
    }
    if (!inTargetImporter) continue;

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
        versions.set(currentPackage, version);
      }
      currentPackage = undefined;
    }
  }

  return versions;
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
 * Parse package-lock.json (npm) to extract resolved versions.
 */
function parseNpmLockVersions(lockContent: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const lock = JSON.parse(lockContent);
    // npm v3: lock.dependencies
    const deps = lock.dependencies ?? {};
    for (const [name, info] of Object.entries(deps)) {
      const depInfo = info as { version?: string };
      if (depInfo.version) {
        // Strip version prefixes like ^, ~, >=
        const cleanVersion = depInfo.version.replace(/^[^0-9]+/, '');
        versions.set(name, cleanVersion);
      }
    }
    // npm v2 (lockfileVersion 2+): lock.packages
    const packages = lock.packages ?? {};
    for (const key of Object.keys(packages)) {
      const pkgInfo = packages[key] as { version?: string };
      if (pkgInfo.version) {
        // Key format: "node_modules/package-name" or "node_modules/@scope/package-name"
        const name = key.replace(/^node_modules\//, '');
        if (!versions.has(name)) {
          versions.set(name, pkgInfo.version);
        }
      }
    }
  } catch {
    // Malformed lockfile — return empty map
  }
  return versions;
}

function parsePnpmAllVersions(lockContent: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inPackages = false;
  for (const raw of lockContent.split(/\r?\n/)) {
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
    const key = unquote(trimmed.slice(0, separator));
    const clean = stripPeerSuffix(key);
    const splitAt = clean.lastIndexOf('@');
    if (splitAt <= 0) continue;
    const name = clean.slice(0, splitAt);
    const version = clean.slice(splitAt + 1);
    if (name && /^\d/.test(version) && !versions.has(name)) versions.set(name, version);
  }
  return versions;
}

/**
 * Determine the dependency scope from the manifest section it appears in.
 */
function scopeForSection(section: string): DependencyScope {
  switch (section) {
    case 'dependencies':
      return 'runtime';
    case 'devDependencies':
      return 'development';
    case 'peerDependencies':
      return 'peer';
    case 'optionalDependencies':
      return 'optional';
    default:
      return 'runtime';
  }
}

/**
 * Determine status: local_path for file: / link: / workspace:,
 * git_dependency for git+ / github: / git:, registry otherwise.
 */
function statusForSpec(spec: string): DependencyStatus {
  if (spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('workspace:')) {
    return 'local_path';
  }
  if (spec.startsWith('git+') || spec.startsWith('github:') || spec.startsWith('git:')) {
    return 'git_dependency';
  }
  return 'current';
}

/**
 * Check if a spec is a local/git reference (not resolvable to a registry version).
 */
function isRegistrySpec(spec: string): boolean {
  return (
    !spec.startsWith('file:') &&
    !spec.startsWith('link:') &&
    !spec.startsWith('workspace:') &&
    !spec.startsWith('git+') &&
    !spec.startsWith('github:') &&
    !spec.startsWith('git:')
  );
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class NpmAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'npm';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    // Pick the actual package.json rather than `manifests[0]` — discovery also
    // reports tsconfig.json as a manifest, and sort order is not a contract.
    const manifestPath = resolveIn(
      root,
      workspace.manifests.find((m) => m.endsWith('package.json')) ?? 'package.json',
    );

    // Read package.json
    let pkg: PackageJson;
    let manifestContent: string;
    try {
      manifestContent = await readFile(manifestPath, 'utf-8');
      pkg = JSON.parse(manifestContent) as PackageJson;
    } catch {
      return []; // Can't read manifest — no dependencies
    }

    const manifestEv = manifestEvidence(manifestPath);

    // Read lockfile for resolved versions
    const lockInfo = await detectLockfile(root, options.projectRoot);
    const resolvedVersions = new Map<string, string>();
    const allLockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    if (lockInfo.kind === 'pnpm') {
      try {
        const lockContent = await readFile(lockInfo.path, 'utf-8');
        // The importer key is this workspace's path relative to the lockfile,
        // POSIX-style; the root workspace is `.`.
        const importerPath =
          relative(dirname(lockInfo.path), root).split(/[/\\]/).filter(Boolean).join('/') || '.';
        const parsed = parsePnpmImporterVersions(lockContent, importerPath);
        for (const [k, v] of parsed) resolvedVersions.set(k, v);
        for (const [k, v] of parsePnpmAllVersions(lockContent)) allLockVersions.set(k, v);
        if (parsed.size > 0) lockEv = lockfileEvidence(lockInfo.path);
      } catch {
        // ignore
      }
    } else if (lockInfo.kind === 'npm') {
      try {
        const lockContent = await readFile(lockInfo.path, 'utf-8');
        const parsed = parseNpmLockVersions(lockContent);
        for (const [k, v] of parsed) resolvedVersions.set(k, v);
        for (const [k, v] of parsed) allLockVersions.set(k, v);
        lockEv = lockfileEvidence(lockInfo.path);
      } catch {
        // ignore
      }
    }

    // Process each dependency section
    const sections: Array<{ name: string; deps: PackageJsonDeps | undefined }> = [
      { name: 'dependencies', deps: pkg.dependencies },
      { name: 'devDependencies', deps: pkg.devDependencies },
      { name: 'peerDependencies', deps: pkg.peerDependencies },
      { name: 'optionalDependencies', deps: pkg.optionalDependencies },
    ];

    const seen = new Set<string>(); // dedup within workspace

    for (const section of sections) {
      if (!section.deps) continue;
      const scope = scopeForSection(section.name);

      for (const [name, requested] of Object.entries(section.deps)) {
        const dedupKey = `${name}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const isRegistry = isRegistrySpec(requested);
        const status = statusForSpec(requested);

        // Resolve locked version from lockfile
        const locked = resolvedVersions.get(name);

        // Build PURL for registry deps
        const purl =
          isRegistry && locked
            ? buildPurl({ type: 'npm', name, version: locked })
            : isRegistry
              ? buildPurl({ type: 'npm', name })
              : undefined;

        const evidence: Evidence[] = [manifestEv];
        if (lockEv && locked) evidence.push(lockEv);

        observations.push({
          id: `dep-${workspace.id}-${name}`,
          workspaceId: workspace.id,
          ...(purl ? { purl } : {}),
          ecosystem: 'npm' as const,
          name,
          sourceType: isRegistry ? 'registry' : status === 'local_path' ? 'path' : 'git',
          direct: true,
          scope,
          requested,
          ...(locked ? { locked } : {}),
          status,
          evidence,
        });
      }
    }

    if (options.includeTransitive && lockEv) {
      for (const [name, locked] of allLockVersions) {
        if (seen.has(name)) continue;
        seen.add(name);
        observations.push({
          id: `dep-${workspace.id}-${name}`,
          workspaceId: workspace.id,
          purl: buildPurl({ type: 'npm', name, version: locked }),
          ecosystem: 'npm',
          name,
          sourceType: 'registry',
          direct: false,
          scope: 'transitive',
          locked,
          status: 'current',
          evidence: [lockEv],
        });
      }
    }

    return observations;
  }
}

/**
 * Default singleton instance.
 */
export const npmAdapter = new NpmAdapter();
