/**
 * TechStack — PHP ecosystem adapter.
 *
 * Parses composer.json and composer.lock to produce
 * DependencyObservation[] for PHP workspaces.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier A
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPurl } from '../registry/purl.js';
import type {
  DependencyObservation,
  DependencyScope,
  EcosystemId,
  Evidence,
  Workspace,
} from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { fileExists, lockfileEvidence, manifestEvidence, workspaceRoot } from './paths.js';

// ── Helpers ───────────────────────────────────────────────────────────────

// ── composer.json types ────────────────────────────────────────────────────

interface ComposerJson {
  readonly require?: Record<string, string>;
  readonly 'require-dev'?: Record<string, string>;
}

// ── composer.lock types ───────────────────────────────────────────────────

interface ComposerLockPackage {
  readonly name: string;
  readonly version: string;
  readonly type?: string;
  readonly require?: Record<string, string>;
  readonly 'require-dev'?: Record<string, string>;
}

interface ComposerLock {
  readonly packages?: ComposerLockPackage[];
  readonly 'packages-dev'?: ComposerLockPackage[];
}

/**
 * Parse a composer.lock file to extract resolved versions.
 */
function parseComposerLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const lock = JSON.parse(content) as ComposerLock;
    for (const pkg of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) {
      versions.set(pkg.name, pkg.version);
    }
  } catch {
    // Malformed lockfile
  }
  return versions;
}

/**
 * Determine status from version constraint.
 */
function statusForComposerSpec(spec: string): DependencyObservation['status'] {
  if (spec.startsWith('file:') || spec.startsWith('path:')) return 'local_path';
  if (spec.startsWith('git@') || spec.startsWith('git:') || spec.startsWith('http'))
    return 'git_dependency';
  return 'current';
}

/**
 * Determine sourceType from version constraint.
 */
function sourceTypeForComposerSpec(
  spec: string,
): Exclude<DependencyObservation['sourceType'], undefined> {
  if (spec.startsWith('file:') || spec.startsWith('path:')) return 'path';
  if (spec.startsWith('git@') || spec.startsWith('git:') || spec.startsWith('http')) return 'git';
  return 'registry';
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class PhpAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'php';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    const seen = new Set<string>();

    // Find composer.json
    const composerJsonPath =
      workspace.manifests.find((m) => m.includes('composer.json')) ||
      (fileExists(join(root, 'composer.json')) ? join(root, 'composer.json') : undefined);
    if (!composerJsonPath) return [];

    let content: string;
    try {
      content = readFileSync(composerJsonPath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(composerJsonPath);

    // Parse composer.json
    let composerJson: ComposerJson;
    try {
      composerJson = JSON.parse(content) as ComposerJson;
    } catch {
      return [];
    }

    // Parse composer.lock for resolved versions
    const lockPath = join(root, 'composer.lock');
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    try {
      const lockContent = readFileSync(lockPath, 'utf-8');
      lockVersions = parseComposerLock(lockContent);
      lockEv = lockfileEvidence(lockPath);
    } catch {
      // No lockfile
    }

    // Process require (runtime deps) and require-dev (dev deps)
    const sections: Array<{ deps: Record<string, string> | undefined; scope: DependencyScope }> = [
      { deps: composerJson.require, scope: 'runtime' },
      { deps: composerJson['require-dev'], scope: 'development' },
    ];

    for (const { deps, scope } of sections) {
      if (!deps) continue;
      for (const [name, constraint] of Object.entries(deps)) {
        if (seen.has(name)) continue;
        seen.add(name);

        const locked = lockVersions.get(name);
        const status = statusForComposerSpec(constraint);
        const sourceType = sourceTypeForComposerSpec(constraint);
        const isRegistry = sourceType === 'registry';

        const purl =
          isRegistry && locked
            ? buildPurl({ type: 'php', name, version: locked })
            : isRegistry
              ? buildPurl({ type: 'php', name })
              : undefined;

        const evidence: Evidence[] = [manifestEv];
        if (lockEv && locked) evidence.push(lockEv);

        observations.push({
          id: `dep-${workspace.id}-${name}`,
          workspaceId: workspace.id,
          ...(purl ? { purl } : {}),
          ecosystem: 'php',
          name,
          sourceType,
          direct: true,
          scope,
          requested: constraint,
          ...(locked ? { locked } : {}),
          status,
          evidence,
        });
      }
    }

    return observations;
  }
}

/**
 * Default singleton instance.
 */
export const phpAdapter = new PhpAdapter();
