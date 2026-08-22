/**
 * TechStack — .NET ecosystem adapter.
 *
 * Parses .csproj files and project.assets.json to produce
 * DependencyObservation[] for .NET workspaces.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier A
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPurl } from '../registry/purl.js';
import type { DependencyObservation, EcosystemId, Evidence, Workspace } from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { parseXmlAttributes, xmlTagValue } from './parse-utils.js';
import { lockfileEvidence, manifestEvidence, workspaceRoot } from './paths.js';

// ── Minimal XML parser for .csproj ────────────────────────────────────────

interface CsprojPackageRef {
  readonly name: string;
  readonly version: string | undefined;
}

/**
 * Parse a .csproj file to extract PackageReference items.
 * Handles:
 *   <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
 *   <PackageReference Include="Serilog" Version="4.2.0">
 *     <PrivateAssets>all</PrivateAssets>
 *   </PackageReference>
 *   <PackageReference Include="Microsoft.AspNetCore.App" />
 *   Condition attributes are ignored.
 */
function parseCsproj(content: string): CsprojPackageRef[] {
  const refs: CsprojPackageRef[] = [];
  const regex = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  for (const match of content.matchAll(regex)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const parsedAttributes = parseXmlAttributes(attributes);
    const name = parsedAttributes.get('Include');
    if (!name) continue;
    const version = parsedAttributes.get('Version') ?? xmlTagValue(body, 'Version');
    refs.push({ name, version });
  }
  return refs;
}

/**
 * Parse project.assets.json for resolved dependency versions.
 * Format: {
 *   "libraries": {
 *     "Newtonsoft.Json/13.0.3": { ... },
 *     "Serilog/4.2.0": { ... }
 *   }
 * }
 */
function parseProjectAssetsJson(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const json = JSON.parse(content) as {
      libraries?: Record<string, { type?: string }>;
    };
    if (json.libraries) {
      for (const key of Object.keys(json.libraries)) {
        // Format: "PackageName/Version"
        const sepIndex = key.lastIndexOf('/');
        if (sepIndex >= 0) {
          const name = key.slice(0, sepIndex);
          const version = key.slice(sepIndex + 1);
          if (name && version) {
            versions.set(name, version);
          }
        }
      }
    }
  } catch {
    // Malformed JSON
  }
  return versions;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DotNetAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'dotnet';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    const seen = new Set<string>();

    // Find .csproj file via readdirSync
    let csprojPath: string | undefined;
    try {
      const files = await readdir(root);
      const csproj = files.find((f) => f.endsWith('.csproj'));
      if (csproj) csprojPath = join(root, csproj);
    } catch {
      // Can't read directory
    }

    if (!csprojPath) return [];

    let csprojContent: string;
    try {
      csprojContent = await readFile(csprojPath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(csprojPath);

    // Parse PackageReferences
    const refs = parseCsproj(csprojContent);

    // Read project.assets.json for locked versions
    const assetsPath = join(root, 'project.assets.json');
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    try {
      const assetsContent = await readFile(assetsPath, 'utf-8');
      lockVersions = parseProjectAssetsJson(assetsContent);
      lockEv = lockfileEvidence(assetsPath);
    } catch {
      // No assets file
    }

    for (const ref of refs) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);

      const locked = lockVersions.get(ref.name) || ref.version;

      // .NET PackageReferences are always registry (NuGet)
      const purl = locked
        ? buildPurl({ type: 'dotnet', name: ref.name, version: locked })
        : buildPurl({ type: 'dotnet', name: ref.name });

      const evidence: Evidence[] = [manifestEv];
      if (lockEv && lockVersions.has(ref.name)) evidence.push(lockEv);

      observations.push({
        id: `dep-${workspace.id}-${ref.name}`,
        workspaceId: workspace.id,
        purl,
        ecosystem: 'dotnet',
        name: ref.name,
        sourceType: 'registry',
        direct: true,
        scope: 'runtime',
        ...(ref.version ? { requested: ref.version } : {}),
        ...(locked ? { locked } : {}),
        status: 'current',
        evidence,
      });
    }

    return observations;
  }
}

/**
 * Default singleton instance.
 */
export const dotNetAdapter = new DotNetAdapter();
