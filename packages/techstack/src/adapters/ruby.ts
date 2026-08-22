/**
 * TechStack — Ruby/Bundler ecosystem adapter (Tier B).
 *
 * Parses Gemfile and Gemfile.lock for direct and transitive dependencies.
 * Partial support — no registry API; OSV-only advisory enrichment.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier B
 */

import { readFileSync } from 'node:fs';
import { buildPurl } from '../registry/purl.js';
import type {
  DependencyObservation,
  DependencyScope,
  EcosystemId,
  Evidence,
  Workspace,
} from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { lockfileEvidence, manifestEvidence } from './paths.js';

/**
 * Parse Gemfile for direct `gem 'name'` and `gem 'name', 'version'` calls.
 */
function parseGemfile(content: string): Array<{
  name: string;
  version?: string | undefined;
  sourceType: 'registry' | 'git' | 'path';
}> {
  const gems: Array<{
    name: string;
    version?: string | undefined;
    sourceType: 'registry' | 'git' | 'path';
  }> = [];
  const gemRegex = /gem\s+['"]([^'"]+)['"]([^\n]*)/g;
  for (const match of content.matchAll(gemRegex)) {
    const name = match[1]!;
    // Skip gems that are clearly comments or block-evaluated
    if (name === 'rails' || name === 'ruby') continue;
    const tail = match[2] ?? '';
    const version = /^\s*,\s*['"]([^'"]+)['"]/.exec(tail)?.[1];
    const sourceType = /\b(?:git|github):/.test(tail)
      ? 'git'
      : /\bpath:/.test(tail)
        ? 'path'
        : 'registry';
    gems.push({ name, version, sourceType });
  }
  return gems;
}

/**
 * Parse Gemfile.lock `GEM` section for resolved versions.
 * Format: `    name (version)`.
 */
function parseGemfileLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  const lines = content.split('\n');
  let inSpecs = false;
  for (const line of lines) {
    if (/^(?:GEM|GIT|PATH)$/.test(line.trim())) {
      inSpecs = false;
      continue;
    }
    if (/^\s{2}specs:\s*$/.test(line)) {
      inSpecs = true;
      continue;
    }
    if (inSpecs && /^[A-Z]/.test(line) && !line.startsWith(' ')) {
      inSpecs = false;
      continue;
    }
    if (!inSpecs) continue;
    const match = /^\s{4,}([\w-]+)\s+\(([^)]+)\)/.exec(line);
    if (match) {
      const version = match[2]!.split(' ')[0] ?? match[2]!;
      versions.set(match[1]!, version);
    }
  }
  return versions;
}

export class RubyAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'ruby';

  async inventory(
    workspace: Workspace,
    _options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const gemfilePath = workspace.manifests.find((m) => m.includes('Gemfile'));
    if (!gemfilePath) return [];

    let content: string;
    try {
      content = readFileSync(gemfilePath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(gemfilePath);
    const gems = parseGemfile(content);
    const seen = new Set<string>();

    // Parse lockfile
    const lockfilePath = workspace.lockfiles.find((l) => l.includes('Gemfile.lock'));
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    if (lockfilePath) {
      try {
        const lockContent = readFileSync(lockfilePath, 'utf-8');
        lockVersions = parseGemfileLock(lockContent);
        lockEv = lockfileEvidence(lockfilePath);
      } catch {
        // No lockfile
      }
    }

    for (const gem of gems) {
      if (seen.has(gem.name)) continue;
      seen.add(gem.name);

      const locked = lockVersions.get(gem.name);
      const version = locked ?? gem.version;
      const purl =
        gem.sourceType === 'registry' && version
          ? buildPurl({ type: 'gem', name: gem.name, version })
          : gem.sourceType === 'registry'
            ? buildPurl({ type: 'gem', name: gem.name })
            : undefined;

      const evidence: Evidence[] = [manifestEv];
      if (lockEv && locked) evidence.push(lockEv);

      observations.push({
        id: `dep-${workspace.id}-${gem.name}`,
        workspaceId: workspace.id,
        ...(purl ? { purl } : {}),
        ecosystem: 'ruby',
        name: gem.name,
        sourceType: gem.sourceType,
        direct: true,
        scope: 'runtime' as DependencyScope,
        ...(gem.version ? { requested: gem.version } : {}),
        ...(locked ? { locked } : {}),
        status:
          gem.sourceType === 'git'
            ? 'git_dependency'
            : gem.sourceType === 'path'
              ? 'local_path'
              : 'current',
        evidence,
      });
    }

    return observations;
  }
}

export const rubyAdapter = new RubyAdapter();
