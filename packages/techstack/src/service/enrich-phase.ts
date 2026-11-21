import { queryOsvBatch } from '../advisory/osv.js';
import { createLicenseFinding } from '../policy/license.js';
import { detectWorkspaceMisalignments } from '../policy/misalignment.js';
import {
  type AdvisoryStatusData,
  classifyStatus,
  type RegistryStatusData,
} from '../policy/status.js';
import {
  lookupRegistry,
  RegistryAuthError,
  type RegistryEntry,
  RegistryNotFoundError,
} from '../registry/client.js';
import { parsePurl } from '../registry/purl.js';
import type { DependencyObservation, EcosystemId, Evidence, Finding, Snapshot } from '../types.js';
import { createFindingForStatus } from './finding-factory.js';

/** Ecosystems whose registry lookup carries no license data at all. */
const LICENSE_BLIND_ECOSYSTEMS: ReadonlySet<string> = new Set([
  'go',
  'golang',
  'dotnet',
  'nuget',
  'dart',
  'pub',
]);

export interface EnrichOptions {
  readonly online?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly forceRegistryRefresh?: boolean | undefined;
}

export async function runEnrichPhase(
  snapshot: Snapshot,
  options: EnrichOptions = {},
): Promise<Snapshot> {
  if (options.online === false || options.signal?.aborted) return snapshot;
  const grouped = new Map<EcosystemId, DependencyObservation[]>();
  for (const dependency of snapshot.dependencies) {
    if (!dependency.purl || dependency.sourceType === 'path' || dependency.sourceType === 'git')
      continue;
    grouped.set(dependency.ecosystem, [...(grouped.get(dependency.ecosystem) ?? []), dependency]);
  }
  const enriched = new Map<string, DependencyObservation>();
  const findings: Finding[] = [...snapshot.findings];
  for (const [ecosystem, dependencies] of grouped) {
    for (const name of new Set(dependencies.map((dependency) => dependency.name))) {
      if (options.signal?.aborted) throw new DOMException('TechStack job cancelled', 'AbortError');
      let registryEntry: RegistryEntry | undefined;
      let registryStatus: RegistryStatusData | undefined;
      try {
        registryEntry = await lookupRegistry(ecosystem, name, {
          signal: options.signal,
          force: options.forceRegistryRefresh,
          strictErrors: true,
        });
        registryStatus = registryEntry
          ? {
              latestStable: registryEntry.latestStable,
              deprecated: registryEntry.deprecated,
              yanked: registryEntry.yanked,
              evidence: [
                {
                  kind: 'registry',
                  source: registryEntry.source,
                  retrievedAt: registryEntry.retrievedAt,
                  detail: `latestStable: ${registryEntry.latestStable ?? 'N/A'}, license: ${registryEntry.license ?? 'N/A'}`,
                },
              ],
            }
          : { privateOrUnresolved: true };
      } catch (error) {
        if (options.signal?.aborted) {
          throw new DOMException('TechStack job cancelled', 'AbortError');
        }
        const unresolved =
          error instanceof RegistryNotFoundError || error instanceof RegistryAuthError;
        registryStatus = unresolved
          ? {
              privateOrUnresolved: true,
              evidence: [
                {
                  kind: 'registry',
                  source: `${ecosystem} registry for ${name}`,
                  retrievedAt: new Date().toISOString(),
                  detail: error.message,
                },
              ],
            }
          : {
              lookupFailed: true,
              evidence: [
                {
                  kind: 'registry',
                  source: `${ecosystem} registry for ${name}`,
                  retrievedAt: new Date().toISOString(),
                  detail: error instanceof Error ? error.message : 'Registry lookup failed',
                },
              ],
            };
      }
      // Per purl, not per name: a vulnerable `minimist@0.0.8` in one
      // workspace must not mark a patched `minimist@1.2.8` vulnerable.
      const advisoryByPurl = new Map<string, AdvisoryStatusData>();
      try {
        // Only purls that pin a version: asked about a bare `pkg:npm/react`,
        // OSV returns every advisory ever filed for the package, which marked
        // an unlocked `react: ^19` vulnerable over react 0.x XSS advisories.
        const purls = dependencies
          .filter((dependency) => dependency.name === name)
          .flatMap((dependency) =>
            dependency.purl && parsePurl(dependency.purl)?.version ? [dependency.purl] : [],
          );
        if (purls.length > 0) {
          const result = await queryOsvBatch(purls, { signal: options.signal });
          for (const [purl, items] of result.advisories) {
            if (items.length > 0)
              advisoryByPurl.set(purl, { hasAdvisory: true, evidence: [result.evidence] });
          }
        }
      } catch {
        if (options.signal?.aborted) {
          throw new DOMException('TechStack job cancelled', 'AbortError');
        }
        // Registry evidence still produces a useful deterministic snapshot.
      }
      for (const dependency of dependencies) {
        if (dependency.name !== name) continue;
        const advisoryStatus = dependency.purl ? advisoryByPurl.get(dependency.purl) : undefined;
        const status = classifyStatus(dependency, registryStatus, advisoryStatus);
        const evidence: Evidence[] = [
          ...dependency.evidence,
          ...(registryStatus?.evidence ?? []),
          ...(advisoryStatus?.evidence ?? []),
        ];
        const license = registryEntry?.license ?? dependency.license;
        enriched.set(dependency.id, {
          ...dependency,
          latestStable: registryEntry?.latestStable ?? dependency.latestStable,
          license,
          deprecated: registryEntry?.deprecated ?? dependency.deprecated,
          yanked: registryEntry?.yanked ?? dependency.yanked,
          status,
          evidence,
        });
        if (status !== 'current' && status !== 'local_path' && status !== 'git_dependency')
          findings.push(createFindingForStatus(dependency.id, status));
        // A registry that never publishes licenses says nothing about the
        // package's license; "No license declared" at confidence 1.0 was
        // raised for every Go, NuGet and pub dependency.
        const licenseFinding =
          license === undefined && LICENSE_BLIND_ECOSYSTEMS.has(ecosystem)
            ? null
            : createLicenseFinding(dependency.id, dependency.name, license);
        if (licenseFinding) findings.push(licenseFinding);
      }
    }
  }
  const enrichedDeps = snapshot.dependencies.map(
    (dependency) => enriched.get(dependency.id) ?? dependency,
  );
  const misalignmentFindings = detectWorkspaceMisalignments(enrichedDeps, snapshot.workspaces);
  findings.push(...misalignmentFindings);
  return { ...snapshot, dependencies: enrichedDeps, findings };
}
