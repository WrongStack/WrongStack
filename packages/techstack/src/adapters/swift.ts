/** Swift Package Manager manifest and resolved-file adapter. */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildPurl } from '../registry/purl.js';
import type { DependencyObservation, EcosystemId, Evidence, Workspace } from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { fileExists, lockfileEvidence, manifestEvidence, workspaceRoot } from './paths.js';

interface SwiftManifestDependency {
  readonly identity: string;
  readonly requested?: string | undefined;
  readonly sourceType: 'git' | 'path';
}

function identityFromLocation(location: string): string {
  return basename(location.replace(/[\\/]$/, ''))
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function parsePackageSwift(content: string): SwiftManifestDependency[] {
  const deps: SwiftManifestDependency[] = [];
  const packageRegex =
    /\.package\s*\(\s*(?:name:\s*["'][^"']+["'],\s*)?(url|path):\s*["']([^"']+)["']\s*(?:,\s*(?:from|exact|branch|revision):\s*["']([^"']+)["'])?\s*\)/g;
  for (const match of content.matchAll(packageRegex)) {
    const location = match[2];
    if (!location) continue;
    deps.push({
      identity: identityFromLocation(location),
      requested: match[3],
      sourceType: match[1] === 'path' ? 'path' : 'git',
    });
  }
  return deps;
}

function parsePackageResolved(
  content: string,
): Map<string, { version?: string; revision?: string }> {
  const pins = new Map<string, { version?: string; revision?: string }>();
  try {
    interface ResolvedPin {
      readonly identity?: string;
      readonly package?: string;
      readonly location?: string;
      readonly repositoryURL?: string;
      readonly state?: { readonly version?: string; readonly revision?: string };
    }
    const json = JSON.parse(content) as {
      pins?: ResolvedPin[];
      object?: { pins?: ResolvedPin[] };
    };
    for (const pin of json.pins ?? json.object?.pins ?? []) {
      const identity = (
        pin.identity ??
        pin.package ??
        (pin.location ? identityFromLocation(pin.location) : undefined) ??
        (pin.repositoryURL ? identityFromLocation(pin.repositoryURL) : undefined)
      )?.toLowerCase();
      if (identity)
        pins.set(identity, {
          ...(pin.state?.version ? { version: pin.state.version } : {}),
          ...(pin.state?.revision ? { revision: pin.state.revision } : {}),
        });
    }
  } catch {
    // Malformed resolved file yields no lock evidence.
  }
  return pins;
}

export class SwiftAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'swift';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const root = workspaceRoot(workspace, options);
    const manifestPath =
      workspace.manifests.find((path) => path.endsWith('Package.swift')) ??
      join(root, 'Package.swift');
    if (!fileExists(manifestPath)) return [];
    const direct = parsePackageSwift(readFileSync(manifestPath, 'utf8'));
    const resolvedPath =
      workspace.lockfiles.find((path) => path.endsWith('Package.resolved')) ??
      join(root, 'Package.resolved');
    const pins = fileExists(resolvedPath)
      ? parsePackageResolved(readFileSync(resolvedPath, 'utf8'))
      : new Map<string, { version?: string; revision?: string }>();
    const manifestEv = manifestEvidence(manifestPath);
    const lockEv = pins.size > 0 ? lockfileEvidence(resolvedPath) : undefined;
    const observations: DependencyObservation[] = [];
    const seen = new Set<string>();

    const add = (
      identity: string,
      requested: string | undefined,
      sourceType: 'git' | 'path',
      isDirect: boolean,
    ): void => {
      if (seen.has(identity)) return;
      seen.add(identity);
      const pin = pins.get(identity);
      const version = pin?.version ?? pin?.revision ?? requested;
      const evidence: Evidence[] = isDirect ? [manifestEv] : [];
      if (lockEv && pin) evidence.push(lockEv);
      observations.push({
        id: `dep-${workspace.id}-${identity}`,
        workspaceId: workspace.id,
        ...(sourceType === 'git'
          ? { purl: buildPurl({ type: 'swift', name: identity, ...(version ? { version } : {}) }) }
          : {}),
        ecosystem: 'swift',
        name: identity,
        sourceType,
        direct: isDirect,
        scope: isDirect ? 'runtime' : 'transitive',
        ...(requested ? { requested } : {}),
        ...(pin?.version ? { locked: pin.version } : pin?.revision ? { locked: pin.revision } : {}),
        status: sourceType === 'path' ? 'local_path' : 'git_dependency',
        evidence,
      });
    };

    for (const dep of direct) add(dep.identity, dep.requested, dep.sourceType, true);
    if (options.includeTransitive) {
      for (const [identity] of pins) add(identity, undefined, 'git', false);
    }
    return observations;
  }
}

export const swiftAdapter = new SwiftAdapter();
