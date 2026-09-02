/**
 * TechStack — Status classification policy.
 *
 * Classifies a DependencyObservation's status based on registry metadata,
 * advisory data, and version comparison rules.
 *
 * Key contracts (per SDD R8/R9):
 * - Private/unresolved (404/401) → `private_or_unresolved` (never `dead` or `deprecated`)
 * - Offline/failed lookup → `unknown` (never `current`)
 * - Registry says deprecated → `deprecated`
 * - Registry says yanked → `yanked`
 * - Advisory found → `vulnerable`
 *
 * @see docs/specs/techstack-sdd.md §7, R8, R9
 */

import type { DependencyObservation, DependencyStatus, Evidence } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** Registry metadata used for status classification. */
export interface RegistryStatusData {
  readonly latestStable?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly yanked?: boolean | undefined;
  /** Whether the registry lookup resulted in a 404/401 (private/unresolved). */
  readonly privateOrUnresolved?: boolean | undefined;
  /** Whether the registry lookup failed due to network error / timeout / offline. */
  readonly lookupFailed?: boolean | undefined;
  /** The evidence from the registry lookup. */
  readonly evidence?: readonly Evidence[] | undefined;
}

/** Advisory data used for status classification. */
export interface AdvisoryStatusData {
  /** Whether any advisory was found for this dependency. */
  readonly hasAdvisory: boolean;
  /** The evidence from the advisory lookup. */
  readonly evidence?: readonly Evidence[] | undefined;
}

// ── Version comparison helpers ─────────────────────────────────────────────

/**
 * Check if a version string looks like a valid semver.
 */
function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version);
}

/**
 * Compare two semver-like version strings.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 * Handles prerelease tags per semver: `1.0.0-alpha < 1.0.0`.
 */
export function compareVersions(a: string, b: string): number {
  // Split off prerelease segment(s) from each version
  // Match: numeric segment | alphanumeric prerelease segment
  const aMatch = a.match(/^([^-]+)(?:-(.+))?$/);
  const bMatch = b.match(/^([^-]+)(?:-(.+))?$/);
  const aBase = aMatch?.[1] ?? a;
  const aPre = aMatch?.[2];
  const bBase = bMatch?.[1] ?? b;
  const bPre = bMatch?.[2];

  // Compare base segments numerically
  const aBaseParts = aBase.split('.').map(Number);
  const bBaseParts = bBase.split('.').map(Number);

  for (let i = 0; i < Math.max(aBaseParts.length, bBaseParts.length); i++) {
    const aNum = aBaseParts[i] ?? 0;
    const bNum = bBaseParts[i] ?? 0;
    if (aNum > bNum) return 1;
    if (aNum < bNum) return -1;
  }

  // Base parts equal → prerelease handling
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1; // no prerelease > has prerelease
  if (bPre === undefined) return -1; // has prerelease < no prerelease
  // Both have prerelease — compare dot-separated identifiers
  // Numeric identifiers compare numerically; non-numeric compare lexically.
  const aPreParts = aPre.split('.');
  const bPreParts = bPre.split('.');
  for (let i = 0; i < Math.max(aPreParts.length, bPreParts.length); i++) {
    const aId = aPreParts[i] ?? '';
    const bId = bPreParts[i] ?? '';
    if (aId === bId) continue;
    const aNum = Number(aId);
    const bNum = Number(bId);
    if (
      !Number.isNaN(aNum) &&
      !Number.isNaN(bNum) &&
      Number.isFinite(aNum) &&
      Number.isFinite(bNum)
    ) {
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
    } else {
      if (aId > bId) return 1;
      if (aId < bId) return -1;
    }
    return aId > bId ? 1 : -1;
  }
  return 0;
}

/**
 * Check if a constraint string is a simple semver range (^, ~, >=, exact).
 * Returns the expression boundary characters for comparison purposes.
 */
function isSimpleConstraint(constraint: string): boolean {
  return (
    constraint.startsWith('^') ||
    constraint.startsWith('~') ||
    constraint.startsWith('>=') ||
    constraint.startsWith('>') ||
    isValidSemver(constraint)
  );
}

/**
 * Check if upgrading from `locked` to `latestStable` would be breaking
 * based on the constraint.
 *
 * Simple heuristic:
 * - ^ means compatible (major must match)
 * - ~ means approximately (minor must match)
 * - >= means compatible if major matches
 * - an exact pin is a manifest constraint, not a compatibility one — still
 *   only breaking on a major bump
 */
function isBreakingUpgrade(locked: string, latestStable: string, constraint?: string): boolean {
  const constraintNorm = constraint?.trim() ?? '';

  // Get major versions
  const lockedMajor = locked.split('.')[0];
  const latestMajor = latestStable.split('.')[0];

  if (!lockedMajor || !latestMajor) return true;

  // `^` — compatible, only breaking if major changes
  if (constraintNorm.startsWith('^')) {
    return lockedMajor !== latestMajor;
  }

  // `~` — approximately equivalent, breaking if minor changes (and we have it)
  if (constraintNorm.startsWith('~')) {
    const lockedMinor = locked.split('.')[1];
    const latestMinor = latestStable.split('.')[1];
    if (lockedMinor && latestMinor && lockedMajor !== latestMajor) return true;
    if (lockedMinor && latestMinor && lockedMinor !== latestMinor) return true;
    return false;
  }

  // `>=` — compatible if major matches
  if (constraintNorm.startsWith('>=') || constraintNorm.startsWith('>')) {
    return lockedMajor !== latestMajor;
  }

  // Exact pin (`"biome": "2.5.3"`). The pin means "don't move without a
  // decision", but that is a manifest question, not a compatibility one —
  // breaking is still a major bump. Treating every pinned patch release as
  // breaking flags most of a pin-heavy repo as a major upgrade.
  if (isValidSemver(constraintNorm)) {
    return lockedMajor !== latestMajor;
  }

  // Unknown constraint type — assume breaking
  return lockedMajor !== latestMajor;
}

// ── Main classification function ───────────────────────────────────────────

/**
 * Classify a dependency's status based on its current data plus optional
 * registry metadata and advisory information.
 *
 * @param dep - The dependency observation from the inventory pass.
 * @param registryData - Optional registry metadata (from lookupRegistry).
 * @param advisoryData - Optional advisory data (from OSV or native audit).
 * @returns The classified DependencyStatus.
 */
export function classifyStatus(
  dep: Pick<DependencyObservation, 'name' | 'sourceType' | 'status' | 'locked' | 'requested'>,
  registryData?: RegistryStatusData,
  advisoryData?: AdvisoryStatusData,
): DependencyStatus {
  // ── Source-type based classifications ─────────────────────────────────

  // Local path deps
  if (dep.sourceType === 'path') {
    return 'local_path';
  }

  // Git deps
  if (dep.sourceType === 'git') {
    return 'git_dependency';
  }

  // ── Private/unresolved (404/401) — never dead, never deprecated ────────

  if (registryData?.privateOrUnresolved) {
    return 'private_or_unresolved';
  }

  // ── Lookup failed — never current, never up-to-date ────────────────────

  if (registryData?.lookupFailed) {
    return 'unknown';
  }

  // ── Deprecated / yanked ────────────────────────────────────────────────

  if (registryData?.deprecated) {
    return 'deprecated';
  }

  if (registryData?.yanked) {
    return 'yanked';
  }

  // ── Vulnerable ─────────────────────────────────────────────────────────

  if (advisoryData?.hasAdvisory) {
    return 'vulnerable';
  }

  // ── Version comparison ─────────────────────────────────────────────────

  const locked = dep.locked;
  const latestStable = registryData?.latestStable;

  if (locked && latestStable) {
    if (locked === latestStable) {
      return 'current';
    }

    try {
      const cmp = compareVersions(locked, latestStable);
      if (cmp < 0) {
        // locked < latestStable
        const constraint = dep.requested;
        if (constraint && isSimpleConstraint(constraint)) {
          const breaking = isBreakingUpgrade(locked, latestStable, constraint);
          return breaking ? 'update_available_breaking' : 'update_available_safe';
        }
        // No constraint or complex constraint — conservative: assume safe
        return 'update_available_safe';
      }
      // locked > latestStable — this shouldn't normally happen for registry deps
      // but handle gracefully as current
      return 'current';
    } catch {
      // Version comparison failed — fall through to registry-based status
    }
  }

  // ── Holdover status from inventory pass ────────────────────────────────

  // If the adapter already classified this (e.g. local_path, git_dependency),
  // respect that classification
  if (dep.status === 'local_path' || dep.status === 'git_dependency') {
    return dep.status;
  }

  // ── Default ────────────────────────────────────────────────────────────

  return dep.status ?? 'current';
}

/**
 * Create a registry status data object indicating a private/unresolved package.
 */
export function privateOrUnresolvedStatus(source: string, detail?: string): RegistryStatusData {
  return {
    privateOrUnresolved: true,
    evidence: [
      {
        kind: 'registry',
        source,
        retrievedAt: new Date().toISOString(),
        detail: detail ?? 'Package returned 404/401 — private or unresolved',
      },
    ],
  };
}

/**
 * Create a registry status data object indicating a failed/offline lookup.
 */
export function failedLookupStatus(source: string, error?: string): RegistryStatusData {
  return {
    lookupFailed: true,
    evidence: [
      {
        kind: 'registry',
        source,
        retrievedAt: new Date().toISOString(),
        detail: error ?? 'Registry lookup failed — network error or timeout',
      },
    ],
  };
}
