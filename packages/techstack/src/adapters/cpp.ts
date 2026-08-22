/**
 * TechStack — C/C++ ecosystem adapter (Tier C).
 *
 * Best-effort: parses conanfile.txt / conanfile.py for `[requires]` and
 * vcpkg.json for dependencies. No lockfile resolution; coverage='unsupported'.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier C
 */

import { readFileSync } from 'node:fs';
import { buildPurl } from '../registry/purl.js';
import type { DependencyObservation, EcosystemId, Workspace } from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { manifestEvidence } from './paths.js';

/**
 * Parse conanfile.txt `[requires]` section.
 */
function parseConanTxt(content: string): Array<{ name: string; version?: string | undefined }> {
  const deps: Array<{ name: string; version?: string | undefined }> = [];
  const requiresMatch = /\[requires\]\s*\n([\s\S]*?)(?:\[|$)/;
  const block = requiresMatch.exec(content)?.[1];
  if (!block) return deps;

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('/');
    if (parts.length >= 2) {
      deps.push({ name: parts[0]!, version: parts[1] });
    } else {
      deps.push({ name: trimmed });
    }
  }
  return deps;
}

/**
 * Parse vcpkg.json `dependencies` array.
 */
function parseVcpkgJson(content: string): Array<{ name: string; version?: string | undefined }> {
  const deps: Array<{ name: string; version?: string | undefined }> = [];
  try {
    const json = JSON.parse(content) as {
      dependencies?: Array<string | { name: string; version?: string }>;
    };
    for (const dep of json.dependencies ?? []) {
      if (typeof dep === 'string') {
        deps.push({ name: dep });
      } else {
        deps.push({ name: dep.name, version: dep.version });
      }
    }
  } catch {
    // Malformed
  }
  return deps;
}

export class CppAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'cpp';

  async inventory(
    workspace: Workspace,
    _options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const seen = new Set<string>();

    for (const manifestPath of workspace.manifests) {
      let content: string;
      try {
        content = readFileSync(manifestPath, 'utf-8');
      } catch {
        continue;
      }

      const manifestEv = manifestEvidence(manifestPath);
      let deps: Array<{ name: string; version?: string | undefined }> = [];

      if (manifestPath.includes('conanfile')) {
        deps = parseConanTxt(content);
      } else if (manifestPath.includes('vcpkg.json')) {
        deps = parseVcpkgJson(content);
      } else {
        continue;
      }

      for (const dep of deps) {
        if (seen.has(dep.name)) continue;
        seen.add(dep.name);

        const purl = dep.version
          ? buildPurl({ type: 'conan', name: dep.name, version: dep.version })
          : buildPurl({ type: 'conan', name: dep.name });

        observations.push({
          id: `dep-${workspace.id}-${dep.name}`,
          workspaceId: workspace.id,
          purl,
          ecosystem: 'cpp',
          name: dep.name,
          sourceType: 'registry',
          direct: true,
          scope: 'runtime',
          ...(dep.version ? { requested: dep.version } : {}),
          // Tier C — we cannot verify current/version status
          status: 'unknown',
          evidence: [manifestEv],
        });
      }
    }

    return observations;
  }
}

export const cppAdapter = new CppAdapter();
