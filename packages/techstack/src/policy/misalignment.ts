/**
 * TechStack — Cross-Workspace Version Drift & Misalignment Detector.
 *
 * In monorepo projects, different workspaces (packages/apps) may declare
 * or resolve different versions of the same dependency, leading to bundle
 * bloat, runtime inconsistencies, and duplicate lockfile resolutions.
 *
 * @see docs/specs/techstack-sdd.md §4.1, §7
 */

import type { DependencyObservation, Finding, Workspace } from '../types.js';

export interface VersionMisalignment {
  readonly ecosystem: string;
  readonly name: string;
  readonly distinctVersions: readonly string[];
  readonly occurrences: ReadonlyArray<{
    readonly dependencyId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly version: string;
  }>;
}

/**
 * Detects third-party dependency version mismatches across multiple workspaces.
 */
export function detectWorkspaceMisalignments(
  dependencies: readonly DependencyObservation[],
  workspaces: readonly Workspace[],
): readonly Finding[] {
  if (workspaces.length <= 1 || dependencies.length === 0) {
    return [];
  }

  const workspaceRootById = new Map<string, string>();
  for (const ws of workspaces) {
    workspaceRootById.set(ws.id, ws.relativeRoot || '.');
  }

  // Group dependencies by `ecosystem:name` (excluding local path / git dependencies)
  const byPackage = new Map<string, DependencyObservation[]>();
  for (const dep of dependencies) {
    if (dep.sourceType === 'path' || dep.sourceType === 'git') continue;
    const key = `${dep.ecosystem}:${dep.name}`;
    const list = byPackage.get(key) ?? [];
    list.push(dep);
    byPackage.set(key, list);
  }

  const findings: Finding[] = [];

  for (const [_key, deps] of byPackage) {
    if (deps.length <= 1) continue;

    // Check if distinct versions exist across different workspaces
    const versionByWs = new Map<string, string>();
    for (const dep of deps) {
      const version = dep.locked ?? dep.requested ?? 'unknown';
      versionByWs.set(dep.workspaceId, version);
    }

    const uniqueVersions = new Set(versionByWs.values());
    if (uniqueVersions.size <= 1) continue;

    // Build human-readable version distribution summary
    const summaryParts: string[] = [];
    for (const [wsId, ver] of versionByWs) {
      const root = workspaceRootById.get(wsId) ?? wsId;
      summaryParts.push(`${root} (${ver})`);
    }
    const versionSummary = summaryParts.join(', ');

    for (const dep of deps) {
      const currentVer = dep.locked ?? dep.requested ?? 'unknown';
      const root = workspaceRootById.get(dep.workspaceId) ?? dep.workspaceId;

      findings.push({
        id: `finding-${dep.id}-misalignment`,
        dependencyId: dep.id,
        type: 'investigate',
        severity: 'info',
        action: 'investigate',
        confidence: 1.0,
        rationale: `Version mismatch across workspaces: ${root} uses ${currentVer} while other packages differ [${versionSummary}]`,
        evidence: [
          {
            kind: 'manifest',
            source: 'monorepo-alignment',
            retrievedAt: new Date().toISOString(),
            detail: `Workspace distribution: ${versionSummary}`,
          },
        ],
      });
    }
  }

  return findings;
}
