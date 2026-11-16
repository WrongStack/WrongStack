/**
 * TechStack — .NET ecosystem adapter.
 *
 * Parses .csproj files and project.assets.json to produce
 * DependencyObservation[] for .NET workspaces.
 *
 * @see docs/archive/specs/techstack-sdd.md §6 Tier A
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { constructPurl } from '../registry/purl.js';
import type { DependencyObservation, EcosystemId, Evidence, Workspace } from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { parseXmlAttributes, stripXmlComments, xmlTagValue } from './parse-utils.js';
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
/**
 * A NuGet declaration is only usable as a version when it names ONE concrete
 * release. `13.*` (floating) and `[5.0.0,6.0.0)` / `(1.0,)` (ranges) are
 * constraints: they resolve to whatever the restore graph picks, so using one
 * as a version produced the unmatchable `pkg:nuget/Newtonsoft.Json@13.*`.
 */
function isConcreteVersion(declaration: string): boolean {
  // An MSBuild property reference (`$(SerilogVersion)`) is not a version either:
  // unresolved, it became `pkg:nuget/Serilog@$(SerilogVersion)`.
  return (
    !declaration.includes('*') &&
    !declaration.includes('$(') &&
    !declaration.startsWith('[') &&
    !declaration.startsWith('(')
  );
}

function parseCsproj(content: string): CsprojPackageRef[] {
  const refs: CsprojPackageRef[] = [];
  const regex = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  for (const match of stripXmlComments(content).matchAll(regex)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const parsedAttributes = parseXmlAttributes(attributes);
    const name = parsedAttributes.get('Include');
    if (!name) continue;
    // `VersionOverride` is Central Package Management's per-project override.
    const version =
      parsedAttributes.get('Version') ??
      parsedAttributes.get('VersionOverride') ??
      xmlTagValue(body, 'Version') ??
      xmlTagValue(body, 'VersionOverride');
    refs.push({ name, version });
  }
  return refs;
}

/**
 * Central Package Management: with `ManagePackageVersionsCentrally`, a
 * PackageReference carries no Version — it comes from `<PackageVersion
 * Include="X" Version="1.2.3" />` in the nearest `Directory.Packages.props`
 * (MSBuild walks up from the project). Without it, a fresh clone (no
 * gitignored obj/project.assets.json) reported every CPM dependency with no
 * version, so no advisory lookup ever ran. Keys are lowercased: NuGet ids are
 * case-insensitive.
 */
async function readCentralPackageVersions(projectDir: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  let dir = resolve(projectDir);
  for (;;) {
    let content: string | undefined;
    try {
      content = await readFile(join(dir, 'Directory.Packages.props'), 'utf-8');
    } catch {
      // keep walking up
    }
    if (content !== undefined) {
      const regex = /<PackageVersion\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageVersion>)/gi;
      for (const match of stripXmlComments(content).matchAll(regex)) {
        const attributes = parseXmlAttributes(match[1] ?? '');
        const name = attributes.get('Include');
        const version = attributes.get('Version') ?? xmlTagValue(match[2] ?? '', 'Version');
        if (name && version) versions.set(name.toLowerCase(), version);
      }
      return versions;
    }
    const parent = dirname(dir);
    if (parent === dir) return versions;
    dir = parent;
  }
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
    const json = JSON.parse(content.replace(/^\uFEFF/, '')) as {
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
            versions.set(name.toLowerCase(), version);
          }
        }
      }
    }
  } catch {
    // Malformed JSON
  }
  return versions;
}

/**
 * Both restore-graph parsers key by lowercased id: NuGet ids are
 * case-insensitive, and the graph records the package's canonical casing
 * (`Newtonsoft.Json`) whatever casing the project file used.
 *
 * Parse NuGet's `packages.lock.json`:
 * `{ dependencies: { "<tfm>": { "<id>": { type, requested, resolved } } } }`.
 * Project references carry no `resolved` and are skipped.
 */
function parseNuGetPackagesLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const json = JSON.parse(content.replace(/^\uFEFF/, '')) as {
      dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>>;
    } | null;
    if (!json || typeof json !== 'object') return versions;
    for (const frameworkDeps of Object.values(json.dependencies ?? {})) {
      for (const [name, entry] of Object.entries(frameworkDeps ?? {})) {
        if (typeof entry?.resolved === 'string' && !versions.has(name.toLowerCase())) {
          versions.set(name.toLowerCase(), entry.resolved);
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

    // The project file: C# `.csproj`, but also F# `.fsproj` / VB `.vbproj` —
    // discovery hands an `.fsproj` workspace to this adapter, and looking for
    // `.csproj` alone inventoried an F# project as empty.
    const isProjectFile = (f: string) => /\.(?:cs|fs|vb)proj$/i.test(f);
    const manifestProject = workspace.manifests.find(isProjectFile);
    let csprojPath: string | undefined = manifestProject
      ? resolve(root, manifestProject)
      : undefined;
    if (!csprojPath) {
      try {
        const files = await readdir(root);
        const project = files.find(isProjectFile);
        if (project) csprojPath = join(root, project);
      } catch {
        // Can't read directory
      }
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
    const centralVersions = refs.some((ref) => !ref.version)
      ? await readCentralPackageVersions(root)
      : new Map<string, string>();

    // Read the NuGet restore graph for locked versions. NuGet writes it to
    // `<project>/obj/project.assets.json`; probing only the workspace root meant
    // the read never succeeded in a real layout, so `locked` silently fell back
    // to the csproj declaration and no lockfile evidence was attached — a
    // floating declaration such as `13.*` was then reported as the resolved
    // version. Discovery-reported lockfiles come first, then both known paths.
    const assetsCandidates = [
      ...workspace.lockfiles.filter((f) => f.endsWith('project.assets.json')),
      join(root, 'obj', 'project.assets.json'),
      join(root, 'project.assets.json'),
    ];
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    for (const candidate of assetsCandidates) {
      try {
        const assetsContent = await readFile(candidate, 'utf-8');
        lockVersions = parseProjectAssetsJson(assetsContent);
        lockEv = lockfileEvidence(candidate);
        break;
      } catch {
        // Try the next known location.
      }
    }
    // No restore graph (obj/ is gitignored, so a fresh clone has none): the
    // COMMITTED NuGet lockfile still pins every resolved version. It was
    // discovered as the workspace lockfile and never read, so a floating
    // `12.*` reference had no version at all while the lockfile said 12.0.3.
    if (!lockEv) {
      const nugetLockCandidates = [
        ...workspace.lockfiles.filter((f) => f.endsWith('packages.lock.json')),
        join(root, 'packages.lock.json'),
      ];
      for (const candidate of nugetLockCandidates) {
        try {
          lockVersions = parseNuGetPackagesLock(await readFile(candidate, 'utf-8'));
          lockEv = lockfileEvidence(candidate);
          break;
        } catch {
          // Try the next known location.
        }
      }
    }

    for (const ref of refs) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);

      // `locked` is the version the RESTORE GRAPH resolved. A declaration is not
      // a resolved version: falling back to it let a floating/range constraint
      // (`13.*`, `[5.0.0,6.0.0)`) become both `locked` and the purl version,
      // emitting `pkg:nuget/Newtonsoft.Json@13.*` — a glob, not an identity, so
      // the SBOM carried a malformed component and every advisory lookup for it
      // failed. A concrete declaration is still a usable stand-in when no graph
      // is present (the pre-existing obj/-path fix only made the graph
      // reachable; this keeps the fallback from reporting a constraint). The
      // declaration itself is always surfaced as `requested` below.
      const declared = ref.version ?? centralVersions.get(ref.name.toLowerCase());
      const lockedFromGraph = lockVersions.get(ref.name.toLowerCase());
      const locked =
        lockedFromGraph ?? (declared && isConcreteVersion(declared) ? declared : undefined);

      // .NET PackageReferences are always registry (NuGet)
      // constructPurl maps the ecosystem id to the canonical PURL type
      // (`pkg:nuget/…`); the raw id (`pkg:dotnet/…`) is unresolvable by this
      // package's own parsePurlEcosystem and by OSV advisory queries.
      const purl = locked
        ? constructPurl('dotnet', ref.name, locked)
        : constructPurl('dotnet', ref.name);

      const evidence: Evidence[] = [manifestEv];
      if (lockEv && lockedFromGraph) evidence.push(lockEv);

      observations.push({
        id: `dep-${workspace.id}-${ref.name}`,
        workspaceId: workspace.id,
        purl,
        ecosystem: 'dotnet',
        name: ref.name,
        sourceType: 'registry',
        direct: true,
        scope: 'runtime',
        ...(declared ? { requested: declared } : {}),
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
