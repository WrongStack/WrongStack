/**
 * TechStack — Dart ecosystem adapter.
 *
 * Parses pubspec.yaml and pubspec.lock to produce
 * DependencyObservation[] for Dart/Flutter workspaces.
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

// ── Minimal YAML parser (line-based, sufficient for pubspec.yaml) ────────

/**
 * Parse a pubspec.yaml to extract dependencies sections.
 * Returns a map of section name → Map of dependency name → constraint.
 *
 * Handles:
 *   dependencies:
 *     flutter:
 *       sdk: flutter
 *     http: ^1.2.0
 *   dev_dependencies:
 *     test: ^1.24.0
 */
function parsePubspecYaml(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection: string | undefined;
  let currentName: string | undefined;

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Section header (no indent): `dependencies:`
    const sectionMatch = trimmed.match(/^(\w[\w-]*):\s*$/);
    if (sectionMatch && line.startsWith(sectionMatch[1]!)) {
      currentSection = sectionMatch[1]!;
      currentName = undefined;
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map());
      }
      continue;
    }

    if (!currentSection) continue;

    // Dependency definition: `  package_name: ^1.0.0`
    // Or sub-properties: `    sdk: flutter` — skip these
    const depMatch = trimmed.match(/^(\S[^:]*?):\s*(.*)$/);
    if (depMatch && line.startsWith('  ') && !line.startsWith('    ')) {
      currentName = depMatch[1]!.trim();
      let constraint = depMatch[2]!.trim();
      // Handle empty constraints (sdk: flutter has constraint as sub-props)
      if (!constraint || constraint.startsWith('{')) {
        constraint = '*';
      }
      const sec = sections.get(currentSection)!;
      sec.set(currentName, constraint);
      continue;
    }

    if (currentName && line.startsWith('    ')) {
      const sec = sections.get(currentSection);
      if (!sec) continue;
      if (/^sdk:\s*flutter\b/.test(trimmed)) sec.set(currentName, 'sdk:flutter');
      else if (/^git:\s*/.test(trimmed)) sec.set(currentName, `git:${trimmed.slice(4).trim()}`);
      else if (/^path:\s*/.test(trimmed)) sec.set(currentName, `path:${trimmed.slice(5).trim()}`);
    }
  }

  return sections;
}

/**
 * Parse pubspec.lock to extract resolved versions.
 * pubspec.lock uses YAML format with packages as a map.
 *
 * packages:
 *   http:
 *     version: "1.2.0"
 *   path:
 *     version: "2.0.0"
 */
function parsePubspecLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  const lines = content.split('\n');
  let currentPackage: string | undefined;
  let inPackages = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }

    if (!inPackages) continue;

    // Package name: `  package_name:`
    const pkgMatch = trimmed.match(/^(\S[^:]*):\s*$/);
    if (pkgMatch && raw.startsWith('  ') && !raw.startsWith('    ')) {
      currentPackage = pkgMatch[1]!.trim();
      continue;
    }

    // Version: `    version: "1.2.0"`
    if (currentPackage) {
      const verMatch = trimmed.match(/^version:\s*"?([^"\s]+)"?\s*$/);
      if (verMatch && raw.startsWith('    ')) {
        versions.set(currentPackage, verMatch[1]!);
        currentPackage = undefined;
      }
    }
  }

  return versions;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DartAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'dart';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    const seen = new Set<string>();

    // Find pubspec.yaml
    const pubspecPath =
      workspace.manifests.find((m) => m.includes('pubspec.yaml')) ||
      (fileExists(join(root, 'pubspec.yaml')) ? join(root, 'pubspec.yaml') : undefined);
    if (!pubspecPath) return [];

    let content: string;
    try {
      content = readFileSync(pubspecPath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(pubspecPath);

    // Parse pubspec.yaml
    const sections = parsePubspecYaml(content);

    // Parse pubspec.lock
    const lockPath = join(root, 'pubspec.lock');
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    try {
      const lockContent = readFileSync(lockPath, 'utf-8');
      lockVersions = parsePubspecLock(lockContent);
      lockEv = lockfileEvidence(lockPath);
    } catch {
      // No lockfile
    }

    // Process sections
    const sectionMapping: Array<{ yamlSection: string; scope: DependencyScope }> = [
      { yamlSection: 'dependencies', scope: 'runtime' },
      { yamlSection: 'dev_dependencies', scope: 'development' },
      { yamlSection: 'dependency_overrides', scope: 'runtime' },
    ];

    for (const { yamlSection, scope } of sectionMapping) {
      const deps = sections.get(yamlSection);
      if (!deps) continue;

      for (const [name, constraint] of deps) {
        if (seen.has(name)) continue;
        seen.add(name);

        // Skip sdk dependencies (they are the Dart SDK itself)
        if (constraint === '*' || constraint === 'sdk:flutter' || constraint.startsWith('{'))
          continue;

        const locked = lockVersions.get(name);

        // Determine status
        let status: DependencyObservation['status'] = 'current';
        let sourceType: Exclude<DependencyObservation['sourceType'], undefined> = 'registry';

        if (constraint.startsWith('path:')) {
          status = 'local_path';
          sourceType = 'path';
        } else if (constraint.startsWith('git:')) {
          status = 'git_dependency';
          sourceType = 'git';
        } else if (constraint.startsWith('{')) {
          // Inline map: e.g. {sdk: flutter}
          status = 'local_path';
          sourceType = 'path';
        }

        const isRegistry = sourceType === 'registry';
        // Strip caret/tilde/>= for PURL — use locked if available
        const purl =
          isRegistry && (locked || constraint)
            ? buildPurl({
                type: 'dart',
                name,
                version: locked || constraint.replace(/^[\^~>=<\s]+/, ''),
              })
            : isRegistry
              ? buildPurl({ type: 'dart', name })
              : undefined;

        const evidence: Evidence[] = [manifestEv];
        if (lockEv && locked) evidence.push(lockEv);

        observations.push({
          id: `dep-${workspace.id}-${name}`,
          workspaceId: workspace.id,
          ...(purl ? { purl } : {}),
          ecosystem: 'dart',
          name,
          sourceType,
          direct: true,
          scope,
          ...(constraint && constraint !== '*' ? { requested: constraint } : {}),
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
export const dartAdapter = new DartAdapter();
