/** Gradle dependency inventory for Groovy/Kotlin DSL and dependency locking. */

import { readFile } from 'node:fs/promises';
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
import {
  fileExistsAsync,
  lockfileEvidence,
  manifestEvidence,
  resolveIn,
  workspaceRoot,
} from './paths.js';

interface GradleDependency {
  readonly name: string;
  readonly requested?: string | undefined;
  readonly scope: DependencyScope;
}

function scopeForConfiguration(configuration: string): DependencyScope {
  if (/test/i.test(configuration)) return 'development';
  if (/compileOnly|annotationProcessor/i.test(configuration)) return 'build';
  if (/runtimeOnly/i.test(configuration)) return 'runtime';
  return 'runtime';
}

function parseVersionCatalog(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  const libraries = new Map<string, string>();
  let section = '';
  for (const raw of content.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    const entry = /^(?:"([^"]+)"|([\w.-]+))\s*=\s*(.+)$/.exec(line);
    if (!entry) continue;
    const key = entry[1] ?? entry[2];
    const value = entry[3];
    if (!key || !value) continue;
    if (section === 'versions') {
      const version = /^["']([^"']+)["']/.exec(value)?.[1];
      if (version) versions.set(key, version);
    } else if (section === 'libraries') {
      const module =
        /\bmodule\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ??
        (() => {
          const group = /\bgroup\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
          const name = /\bname\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
          return group && name ? `${group}:${name}` : undefined;
        })();
      if (!module) continue;
      const version = /\bversion\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
      const ref = /\bversion\.ref\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
      libraries.set(
        key.replace(/-/g, '.'),
        `${module}:${version ?? (ref ? (versions.get(ref) ?? '') : '')}`.replace(/:$/, ''),
      );
    }
  }
  return libraries;
}

function parseGradleManifest(
  content: string,
  catalog: ReadonlyMap<string, string>,
): GradleDependency[] {
  const deps: GradleDependency[] = [];
  const coordinateRegex =
    /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*(?:\(|\s)\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(coordinateRegex)) {
    const configuration = match[1];
    const value = match[2];
    if (!configuration || !value) continue;
    const [group, artifact, version] = value.split(':');
    if (!group || !artifact) continue;
    deps.push({
      name: `${group}:${artifact}`,
      requested: version,
      scope: scopeForConfiguration(configuration),
    });
  }

  const aliasRegex =
    /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(\s*libs\.([\w.]+)\s*\)/g;
  for (const match of content.matchAll(aliasRegex)) {
    const configuration = match[1];
    const alias = match[2];
    if (!configuration || !alias) continue;
    const coordinate = catalog.get(alias);
    if (!coordinate) continue;
    const [group, artifact, version] = coordinate.split(':');
    if (!group || !artifact) continue;
    deps.push({
      name: `${group}:${artifact}`,
      requested: version,
      scope: scopeForConfiguration(configuration),
    });
  }
  return deps;
}

function parseGradleLock(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const coordinate = /^([^:\s=]+):([^:\s=]+):([^=\s]+)(?:=.*)?$/.exec(line);
    if (coordinate?.[1] && coordinate[2] && coordinate[3])
      locked.set(`${coordinate[1]}:${coordinate[2]}`, coordinate[3]);
  }
  return locked;
}

export class GradleAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'gradle';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const root = workspaceRoot(workspace, options);
    const manifestPath =
      workspace.manifests.find((path) => /build\.gradle(?:\.kts)?$/.test(path)) ??
      ((await fileExistsAsync(join(root, 'build.gradle.kts')))
        ? join(root, 'build.gradle.kts')
        : join(root, 'build.gradle'));
    if (!(await fileExistsAsync(resolveIn(root, manifestPath)))) return [];

    const catalogPath = join(root, 'gradle', 'libs.versions.toml');
    const catalog = (await fileExistsAsync(catalogPath))
      ? parseVersionCatalog(await readFile(catalogPath, 'utf8'))
      : new Map<string, string>();
    const direct = parseGradleManifest(
      await readFile(resolveIn(root, manifestPath), 'utf8'),
      catalog,
    );
    const lockPath =
      workspace.lockfiles.find((path) => path.endsWith('gradle.lockfile')) ??
      join(root, 'gradle.lockfile');
    const locked = (await fileExistsAsync(resolveIn(root, lockPath)))
      ? parseGradleLock(await readFile(resolveIn(root, lockPath), 'utf8'))
      : new Map<string, string>();
    const manifestEv = manifestEvidence(resolveIn(root, manifestPath));
    const lockEv = locked.size > 0 ? lockfileEvidence(resolveIn(root, lockPath)) : undefined;
    const observations: DependencyObservation[] = [];
    const seen = new Set<string>();

    const add = (
      name: string,
      requested: string | undefined,
      scope: DependencyScope,
      isDirect: boolean,
    ): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const version = locked.get(name) ?? requested;
      const lockedVersion = locked.get(name);
      const evidence: Evidence[] = isDirect ? [manifestEv] : [];
      if (lockEv && locked.has(name)) evidence.push(lockEv);
      observations.push({
        id: `dep-${workspace.id}-${name}`,
        workspaceId: workspace.id,
        purl: buildPurl({ type: 'maven', name, ...(version ? { version } : {}) }),
        ecosystem: 'gradle',
        name,
        sourceType: 'registry',
        direct: isDirect,
        scope: isDirect ? scope : 'transitive',
        ...(requested ? { requested } : {}),
        ...(lockedVersion ? { locked: lockedVersion } : {}),
        status: 'current',
        evidence,
      });
    };

    for (const dep of direct) add(dep.name, dep.requested, dep.scope, true);
    if (options.includeTransitive) {
      for (const [name] of locked) add(name, undefined, 'transitive', false);
    }
    return observations;
  }
}

export const gradleAdapter = new GradleAdapter();
