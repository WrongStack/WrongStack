import { queryOsvBatch } from '../advisory/osv.js';
import { createLicenseFinding } from '../policy/license.js';
import { detectWorkspaceMisalignments } from '../policy/misalignment.js';
import {
  classifyStatus,
  type AdvisoryStatusData,
  type RegistryStatusData,
} from '../policy/status.js';
import {
  lookupRegistry,
  RegistryAuthError,
  RegistryNotFoundError,
  type RegistryEntry,
} from '../registry/client.js';
import type { DependencyObservation, EcosystemId, Evidence, Finding, Snapshot } from '../types.js';
import { createFindingForStatus } from './finding-factory.js';

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
      let advisoryStatus: AdvisoryStatusData | undefined;
      try {
        const purls = dependencies
          .filter((dependency) => dependency.name === name)
          .flatMap((dependency) => (dependency.purl ? [dependency.purl] : []));
        if (purls.length > 0) {
          const result = await queryOsvBatch(purls, { signal: options.signal });
          if ([...result.advisories.values()].some((items) => items.length > 0)) {
            advisoryStatus = { hasAdvisory: true, evidence: [result.evidence] };
          }
        }
      } catch {
        // Registry evidence still produces a useful deterministic snapshot.
      }
      for (const dependency of dependencies) {
        if (dependency.name !== name) continue;
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
        const licenseFinding = createLicenseFinding(dependency.id, dependency.name, license);
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
