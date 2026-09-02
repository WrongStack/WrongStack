import type { DependencyObservation, Finding } from '../types.js';

export function computeDependencyFingerprint(
  dependencies: readonly DependencyObservation[],
): string {
  const parts = dependencies
    .map(
      (dependency) =>
        `${dependency.name}@${dependency.locked ?? dependency.requested ?? 'unknown'}`,
    )
    .sort()
    .join(',');
  let hash = 0;
  for (let index = 0; index < parts.length; index++) {
    hash = (hash << 5) - hash + parts.charCodeAt(index);
    hash |= 0;
  }
  return `ts-${Math.abs(hash).toString(36)}`;
}

export function createFindingForStatus(dependencyId: string, status: string): Finding {
  const common = { dependencyId, confidence: 1, evidence: [] as const };
  switch (status) {
    case 'vulnerable':
      return {
        ...common,
        id: `finding-${dependencyId}-vuln`,
        type: 'vulnerability',
        severity: 'high',
        action: 'upgrade_patch',
        rationale: 'Known security advisory found for this package',
      };
    case 'deprecated':
      return {
        ...common,
        id: `finding-${dependencyId}-dep`,
        type: 'deprecated',
        severity: 'medium',
        action: 'replace',
        rationale: 'Package is deprecated in the registry',
      };
    case 'yanked':
      return {
        ...common,
        id: `finding-${dependencyId}-yank`,
        type: 'deprecated',
        severity: 'high',
        action: 'replace',
        rationale: 'Package version has been yanked from the registry',
      };
    case 'update_available_safe':
      return {
        ...common,
        id: `finding-${dependencyId}-update`,
        type: 'upgrade',
        severity: 'info',
        action: 'upgrade_minor',
        rationale: 'A newer compatible version is available',
      };
    case 'update_available_breaking':
      return {
        ...common,
        id: `finding-${dependencyId}-major`,
        type: 'upgrade',
        severity: 'low',
        action: 'upgrade_major',
        rationale: 'A newer version is available that may require breaking changes',
      };
    default:
      return {
        ...common,
        confidence: 0.5,
        id: `finding-${dependencyId}-investigate`,
        type: 'investigate',
        severity: 'info',
        action: 'investigate',
        rationale: `Package status is "${status}" — may need investigation`,
      };
  }
}
