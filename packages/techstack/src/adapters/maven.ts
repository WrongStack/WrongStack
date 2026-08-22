/**
 * TechStack — Maven ecosystem adapter (Tier B).
 *
 * Parses pom.xml for direct dependencies. Partial support — no lockfile
 * parsing (Maven has no standardized lockfile); version resolution
 * requires `mvn dependency:tree` which is not invoked here.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier B
 */

import { readFileSync } from 'node:fs';
import { buildPurl } from '../registry/purl.js';
import type { DependencyObservation, DependencyScope, EcosystemId, Workspace } from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { xmlTagValue } from './parse-utils.js';
import { manifestEvidence } from './paths.js';

interface MavenDependency {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version?: string | undefined;
  readonly scope?: string | undefined;
}

/**
 * Minimal XML parser for `<dependency>` blocks inside pom.xml.
 * Does not handle inheritance/dependencyManagement — this is Tier B partial.
 */
function parsePomDependencies(xml: string): MavenDependency[] {
  const deps: MavenDependency[] = [];
  const properties = new Map<string, string>();
  const propertiesBlock = /<properties>([\s\S]*?)<\/properties>/.exec(xml)?.[1] ?? '';
  const propertyRegex = /<([A-Za-z0-9_.-]+)>\s*([^<]+?)\s*<\/\1>/g;
  for (const propertyMatch of propertiesBlock.matchAll(propertyRegex)) {
    const key = propertyMatch[1];
    const value = propertyMatch[2];
    if (key && value) properties.set(key, value.trim());
  }
  const parentBlock = /<parent>([\s\S]*?)<\/parent>/.exec(xml)?.[1];
  if (parentBlock) {
    const parentVersion = xmlTagValue(parentBlock, 'version');
    const parentGroup = xmlTagValue(parentBlock, 'groupId');
    if (parentVersion) {
      properties.set('parent.version', parentVersion);
      properties.set('project.parent.version', parentVersion);
    }
    if (parentGroup) {
      properties.set('parent.groupId', parentGroup);
      properties.set('project.parent.groupId', parentGroup);
    }
  }

  const managed = new Map<string, string>();
  const managementBlock =
    /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(xml)?.[1] ?? '';
  const managementRegex = /<dependency>\s*([\s\S]*?)<\/dependency>/g;
  for (const managementMatch of managementBlock.matchAll(managementRegex)) {
    const block = managementMatch[1];
    if (!block) continue;
    const groupId = xmlTagValue(block, 'groupId');
    const artifactId = xmlTagValue(block, 'artifactId');
    const version = xmlTagValue(block, 'version');
    if (groupId && artifactId && version) managed.set(`${groupId}:${artifactId}`, version);
  }

  const directXml = xml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  const depRegex = /<dependency>\s*([\s\S]*?)<\/dependency>/g;
  for (const match of directXml.matchAll(depRegex)) {
    const block = match[1]!;
    const groupId = xmlTagValue(block, 'groupId');
    const artifactId = xmlTagValue(block, 'artifactId');
    const rawVersion =
      xmlTagValue(block, 'version') ??
      (groupId && artifactId ? managed.get(`${groupId}:${artifactId}`) : undefined);
    const version = rawVersion?.replace(
      /\$\{([^}]+)\}/g,
      (_whole, key: string) => properties.get(key) ?? `\${${key}}`,
    );
    const scope = xmlTagValue(block, 'scope');
    if (groupId && artifactId) {
      deps.push({ groupId, artifactId, version, scope });
    }
  }
  return deps;
}

function mavenScopeToScope(scope: string | undefined): DependencyScope {
  switch (scope) {
    case 'test':
      return 'development';
    case 'provided':
      return 'optional';
    case 'runtime':
      return 'runtime';
    case 'compile':
      return 'runtime';
    default:
      return 'runtime';
  }
}

export class MavenAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'maven';

  async inventory(
    workspace: Workspace,
    _options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const pomPath = workspace.manifests.find((m) => m.includes('pom.xml'));
    if (!pomPath) return [];

    let content: string;
    try {
      content = readFileSync(pomPath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(pomPath);
    const deps = parsePomDependencies(content);
    const seen = new Set<string>();

    for (const dep of deps) {
      const name = `${dep.groupId}:${dep.artifactId}`;
      if (seen.has(name)) continue;
      seen.add(name);

      const purl = dep.version
        ? buildPurl({ type: 'maven', name, version: dep.version })
        : buildPurl({ type: 'maven', name });

      observations.push({
        id: `dep-${workspace.id}-${name}`,
        workspaceId: workspace.id,
        purl,
        ecosystem: 'maven',
        name,
        sourceType: 'registry',
        direct: true,
        scope: mavenScopeToScope(dep.scope),
        ...(dep.version ? { requested: dep.version } : {}),
        status: 'current',
        evidence: [manifestEv],
      });
    }

    return observations;
  }
}

export const mavenAdapter = new MavenAdapter();
