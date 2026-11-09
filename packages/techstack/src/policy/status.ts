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
 * @see docs/archive/specs/techstack-sdd.md §7, R8, R9
 */

import type { DependencyObservation, DependencyStatus, EcosystemId, Evidence } from '../types.js';

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
  return /^[vV]?\d+\.\d+\.\d+/.test(version);
}

/**
 * Drop what is not part of a version's precedence: a leading `v` (Go's proxy
 * answers `v1.2.3` while the Go adapter stores `1.2.3`) and SemVer build
 * metadata (`+build.5`). Left in, `v1` parsed as NaN — every comparison with
 * NaN is false, so the MAJOR component was silently skipped.
 */
function normalizeVersion(version: string): string {
  return version
    .trim()
    .replace(/^v(?=\d)/i, '')
    .replace(/\+.*$/, '');
}

/**
 * Compare two semver-like version strings.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 * Handles prerelease tags per semver: `1.0.0-alpha < 1.0.0`.
 */
export function compareVersions(a: string, b: string): number {
  a = normalizeVersion(a);
  b = normalizeVersion(b);
  // Split off prerelease segment(s) from each version
  // Match: numeric segment | alphanumeric prerelease segment
  const aMatch = a.match(/^([^-]+)(?:-(.+))?$/);
  const bMatch = b.match(/^([^-]+)(?:-(.+))?$/);
  const aBase = aMatch?.[1] ?? a;
  const aPre = aMatch?.[2];
  const bBase = bMatch?.[1] ?? b;
  const bPre = bMatch?.[2];

  // Compare base segments numerically
  const aBaseSegments = aBase.split('.');
  const bBaseSegments = bBase.split('.');
  if (
    aBaseSegments.some((segment) => !/^\d+$/.test(segment)) ||
    bBaseSegments.some((segment) => !/^\d+$/.test(segment))
  ) {
    // PEP 440 forms the semver split cannot read — post-releases
    // (`2.9.0.post0`), hyphen-less pre-releases (`5.0rc1`), `.devN` — used to
    // throw here, and classifyStatus then reported the outdated dependency
    // as `current`.
    const pep = comparePep440(a, b);
    if (pep !== undefined) return pep;
    throw new Error('Invalid numeric version segment');
  }
  const aBaseParts = aBaseSegments.map(BigInt);
  const bBaseParts = bBaseSegments.map(BigInt);

  for (let i = 0; i < Math.max(aBaseParts.length, bBaseParts.length); i++) {
    const aNum = aBaseParts[i] ?? 0n;
    const bNum = bBaseParts[i] ?? 0n;
    if (aNum > bNum) return 1;
    if (aNum < bNum) return -1;
  }

  // Base parts equal → prerelease handling
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1; // no prerelease > has prerelease
  if (bPre === undefined) return -1; // has prerelease < no prerelease
  // Both have prerelease — compare dot-separated identifiers (SemVer §11.4):
  // digits-only identifiers compare numerically and rank below alphanumeric
  // ones, which compare in ASCII order; when every shared identifier is equal,
  // the longer list ranks higher. `Number()` is not a digits-only test —
  // Number('') is 0 (a missing identifier), Number('0x1') is 1, Number('1e1')
  // is 10 — which is how `alpha.0` compared below `alpha` both ways.
  const aPreParts = aPre.split('.');
  const bPreParts = bPre.split('.');
  for (let i = 0; i < Math.max(aPreParts.length, bPreParts.length); i++) {
    const aId = aPreParts[i];
    const bId = bPreParts[i];
    if (aId === undefined || bId === undefined) return aId === undefined ? -1 : 1;
    if (aId === bId) continue;
    const aNumeric = /^\d+$/.test(aId);
    const bNumeric = /^\d+$/.test(bId);
    if (aNumeric && bNumeric && BigInt(aId) !== BigInt(bId)) {
      return BigInt(aId) > BigInt(bId) ? 1 : -1;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aId > bId ? 1 : -1;
  }
  return 0;
}

const PEP440_VERSION =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?(dev)[-_.]?(\d*))?$/i;
const PEP440_PRE_RANK: Readonly<Record<string, number>> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

/** `packaging.version` sort key (local labels excluded); undefined when not PEP 440. */
function pep440Key(version: string): bigint[] | undefined {
  const m = PEP440_VERSION.exec(version);
  if (!m) return undefined;
  const release = m[2]!.split('.').map(BigInt);
  while (release.length > 1 && release[release.length - 1] === 0n) release.pop();
  const hasPre = m[3] !== undefined;
  const hasPost = m[5] !== undefined || m[6] !== undefined;
  const hasDev = m[8] !== undefined;
  const NEG = -1n;
  const POS = BigInt(Number.MAX_SAFE_INTEGER);
  // A dev-only release sorts before its pre-releases; no pre sorts after them.
  const pre: [bigint, bigint] = hasPre
    ? [BigInt(PEP440_PRE_RANK[m[3]!.toLowerCase()]!), BigInt(m[4] || '0')]
    : !hasPost && hasDev
      ? [NEG, NEG]
      : [POS, POS];
  const post = hasPost ? BigInt(m[5] ?? (m[7] || '0')) : NEG;
  const dev = hasDev ? BigInt(m[9] || '0') : POS;
  // Fixed layout: epoch, release length, release…, pre, post, dev — release is
  // compared element-wise below, so the key carries its length first.
  return [BigInt(m[1] ?? '0'), BigInt(release.length), ...release, ...pre, post, dev];
}

/** Compare two PEP 440 versions; undefined when either is not PEP 440. */
function comparePep440(a: string, b: string): number | undefined {
  const ka = pep440Key(a);
  const kb = pep440Key(b);
  if (!ka || !kb) return undefined;
  if (ka[0] !== kb[0]) return ka[0]! > kb[0]! ? 1 : -1;
  const la = Number(ka[1]);
  const lb = Number(kb[1]);
  for (let i = 0; i < Math.max(la, lb); i++) {
    const x = i < la ? ka[2 + i]! : 0n;
    const y = i < lb ? kb[2 + i]! : 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  const ta = ka.slice(2 + la);
  const tb = kb.slice(2 + lb);
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] !== tb[i]) return ta[i]! > tb[i]! ? 1 : -1;
  }
  return 0;
}

/**
 * Check if a constraint string is a simple semver range (^, ~, >=, exact).
 * Returns the expression boundary characters for comparison purposes.
 */
function isSimpleConstraint(constraint: string): boolean {
  constraint = constraint.trim();
  return (
    constraint.startsWith('^') ||
    constraint.startsWith('~') ||
    constraint.startsWith('>=') ||
    constraint.startsWith('>') ||
    // A bare upper bound (`<2`, `<=3.0.0`) or an npm hyphen range — both
    // decided by {@link exceedsDeclaredUpperBound}.
    constraint.startsWith('<') ||
    hyphenRangeUpperBound(constraint) !== undefined ||
    isValidSemver(constraint) ||
    // An exact pin spelled with an operator: Python `==2.31.0`, npm `=2.31.0`.
    /^={1,3}\s*[vV]?\d+\.\d+\.\d+/.test(constraint)
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
 * - an exact pin is a manifest constraint, not a compatibility one — breaking
 *   only across the SemVer compatibility axis (major, or the minor of a 0.x)
 * - an explicit upper bound (`>=2.0,<2.32`, `>=1.0.0 <2.0.0`, `<3`) is the
 *   author's own compatibility statement and decides before any of the above:
 *   breaking exactly when the latest version falls outside it
 */
function isBreakingUpgrade(
  locked: string,
  latestStable: string,
  constraint?: string,
  ecosystem?: EcosystemId,
): boolean {
  const constraintNorm = constraint?.trim() ?? '';
  locked = normalizeVersion(locked);
  latestStable = normalizeVersion(latestStable);

  const exceedsUpperBound = exceedsDeclaredUpperBound(latestStable, constraintNorm, ecosystem);
  if (exceedsUpperBound !== undefined) return exceedsUpperBound;

  // Get major versions
  const lockedMajor = locked.split('.')[0];
  const latestMajor = latestStable.split('.')[0];

  if (!lockedMajor || !latestMajor) return true;

  // `^` — compatible: the breaking axis is the leftmost NON-ZERO component.
  // `^1.2.3` breaks on a major change, `^0.2.3` on a MINOR change and
  // `^0.0.3` on a patch change. A major-only comparison reported
  // 0.2.x → 0.3.0 as a SAFE upgrade even though the range excludes it (the
  // same package's `caretUpper`/`satisfiesRange` encode the correct rule).
  if (constraintNorm.startsWith('^')) return crossesCompatibilityAxis(locked, latestStable);

  // `~` — breaking when a component the tilde locks changes. How many it locks
  // depends on what was written: npm/cargo `~1` is <2.0.0 while `~1.2` and
  // `~1.2.3` are <1.3.0 (resolver.ts `tildeUpper`); PEP 440 `~=2.31` is ==2.*
  // and `~=2.31.0` is ==2.31.*. A fixed "minor locked" reading called every
  // update `~1` / `~=2.31` admits breaking.
  if (constraintNorm.startsWith('~')) {
    const written = /^~=?\s*v?(\d+(?:\.\d+)*)/.exec(constraintNorm)?.[1]?.split('.').length ?? 3;
    const fixed = Math.max(1, constraintNorm.startsWith('~=') ? written - 1 : Math.min(written, 2));
    const lockedParts = locked.split('.');
    const latestParts = latestStable.split('.');
    for (let i = 0; i < fixed; i++) {
      if (lockedParts[i] === undefined || latestParts[i] === undefined) break;
      if (lockedParts[i] !== latestParts[i]) return true;
    }
    return false;
  }

  // `>=` — compatible if major matches
  if (constraintNorm.startsWith('>=') || constraintNorm.startsWith('>')) {
    return lockedMajor !== latestMajor;
  }

  // Exact pin (`"biome": "2.5.3"`) — or Cargo's bare requirement, which IS a
  // caret (`rand = "0.8.5"` means ^0.8.5). Same compatibility axis as `^`:
  // 2.5.3 → 2.6.0 stays safe, but 0.8.5 → 0.9.2 is breaking — a major-only
  // check called every 0.x minor bump a safe upgrade.
  return crossesCompatibilityAxis(locked, latestStable);
}

/**
 * Whether `latestStable` lies above an upper bound written in the constraint
 * (`<V` exclusive, `<=V` inclusive; several are ANDed, as in `>=2.0,<2.32` or
 * `>=1.0.0 <2.0.0`), or the right side of an npm hyphen range (`A - B`).
 * `undefined` when the constraint declares no upper bound, is an OR-range
 * (`||`, where one clause's bound does not bind the others), or a bound is not
 * a comparable version — the caller then falls back to the SemVer heuristic.
 */
function exceedsDeclaredUpperBound(
  latestStable: string,
  constraint: string,
  ecosystem?: EcosystemId,
): boolean | undefined {
  if (constraint.includes('||')) return undefined;
  const bounds: Array<{ version: string; inclusive: boolean }> = [];
  for (const [, inclusive, version] of constraint.matchAll(
    /<(=?)\s*v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)/g,
  )) {
    bounds.push(
      inclusive === '='
        ? inclusivePartialBound(version!, ecosystem)
        : { version: version!, inclusive: false },
    );
  }
  const hyphenBound = hyphenRangeUpperBound(constraint);
  if (hyphenBound) bounds.push(hyphenBound);
  if (bounds.length === 0) return undefined;
  try {
    return bounds.some(({ version, inclusive }) => {
      const cmp = compareVersions(latestStable, version);
      return inclusive ? cmp > 0 : cmp >= 0;
    });
  } catch {
    return undefined;
  }
}

/**
 * Ecosystems whose resolver reads a PARTIAL inclusive bound as "anything in
 * that release line": `<=2.32` is `<2.33.0-0` and `<=2` is `<3.0.0-0`. Checked
 * against npm 11.11's semver 7.7.4 and real cargo 1.93 (`itoa = "<=1.0"`
 * resolves 1.0.18). PEP 440 does NOT (pip 26.2.1: `2.32.1 in <=2.32` is False),
 * and ecosystems not verified here keep that literal reading too.
 */
const PARTIAL_INCLUSIVE_ROUNDS_UP: ReadonlySet<EcosystemId> = new Set(['npm', 'rust']);

/** `<=V`, with a partial `V` widened to its release line where the ecosystem does that. */
function inclusivePartialBound(
  version: string,
  ecosystem: EcosystemId | undefined,
): { version: string; inclusive: boolean } {
  const partial = /^(\d+)(?:\.(\d+))?$/.exec(version);
  if (!partial || !ecosystem || !PARTIAL_INCLUSIVE_ROUNDS_UP.has(ecosystem)) {
    return { version, inclusive: true };
  }
  const [, major, minor] = partial;
  return minor === undefined
    ? { version: `${BigInt(major!) + 1n}.0.0-0`, inclusive: false }
    : { version: `${major}.${BigInt(minor) + 1n}.0-0`, inclusive: false };
}

/**
 * Upper bound of an npm hyphen range `A - B` (whitespace around the `-` is what
 * separates it from a prerelease dash). A full `B` is inclusive (`<=B`); a
 * partial one rounds up the way npm's semver does: `1.2.3 - 2.3` is `<2.4.0-0`
 * and `1.2.3 - 2` is `<3.0.0-0`.
 */
function hyphenRangeUpperBound(
  constraint: string,
): { version: string; inclusive: boolean } | undefined {
  const match =
    /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?\s+-\s+v?(\d+)(?:\.(\d+))?(?:\.(\d+)(-[0-9A-Za-z.-]+)?)?$/.exec(
      constraint,
    );
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (patch !== undefined) {
    return { version: `${major}.${minor}.${patch}${prerelease ?? ''}`, inclusive: true };
  }
  if (minor !== undefined) {
    return { version: `${major}.${BigInt(minor) + 1n}.0-0`, inclusive: false };
  }
  return { version: `${BigInt(major!) + 1n}.0.0-0`, inclusive: false };
}

/** True when the upgrade changes the leftmost non-zero component (SemVer §4). */
function crossesCompatibilityAxis(locked: string, latestStable: string): boolean {
  const [lockedMajor = '', lockedMinor = '', lockedPatch = ''] = locked.split('.');
  const [latestMajor = '', latestMinor = '', latestPatch = ''] = latestStable.split('.');
  if (lockedMajor !== latestMajor) return true;
  if (lockedMajor !== '0') return false;
  if (lockedMinor !== latestMinor) return true;
  if (lockedMinor !== '0') return false;
  return lockedPatch !== latestPatch;
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
  dep: Pick<
    DependencyObservation,
    'name' | 'sourceType' | 'status' | 'locked' | 'installed' | 'requested'
  > & {
    // Partial `<=` bounds read differently per ecosystem; optional so callers
    // without it keep the literal (PEP 440-style) reading.
    readonly ecosystem?: EcosystemId | undefined;
  },
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

  const locked = dep.locked ?? dep.installed;
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
          const breaking = isBreakingUpgrade(locked, latestStable, constraint, dep.ecosystem);
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
