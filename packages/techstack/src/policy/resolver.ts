/**
 * TechStack — Rulebook Resolver (implementation).
 *
 * Pure functions that combine registry evidence (the facts) with a project
 * rulebook (the policy) into a single `ResolvedTarget` per dependency. The
 * resolver is called by the engine after Inventory + Enrichment but before
 * the Analyzer. It does NOT call into the LLM — it only manipulates typed
 * data. The LLM (advisor) reads the resolver's output as input.
 *
 * Determinism: same inputs + same `now` → same output. No I/O and no clock
 * reads (the caller passes `now`), so tests pin the full decision matrix.
 *
 * Decision order (per SDD §1 "deterministic engines for facts"):
 *   1. `latestStable` missing → `registry_unavailable` (never fabricate)
 *   2. `banned` match         → `banned_violated` / `banned_unresolved_replacement`
 *   3. `pinned` match         → `pinned_within_max` / `pinned_above_max`
 *   4. `deferred` match       → `deferred_until_future` / `deferred_overdue`
 *   5. `preferred` match      → `preferred_no_status_change`
 *   6. nothing matched        → `unconstrained`
 *
 * @see packages/techstack/src/policy/rulebook.ts — the input shape.
 * @see packages/techstack/src/policy/status.ts — `compareVersions` is the ONE
 *      semver comparison primitive reused by `satisfiesRange`.
 */

import type { DependencyObservation } from '../types.js';
import type {
  BanEntry,
  DeferEntry,
  PackageSelector,
  PinEntry,
  PreferEntry,
  Rulebook,
  VersionRange,
} from './rulebook.js';
import { compareVersions } from './status.js';

// ── Resolved target ──────────────────────────────────────────────────────

/**
 * Why the resolver decided what it decided. One per affected dependency.
 * The `reason` is a stable identifier — used by tests and by the UI as a
 * translation key. The `detail` is a human-readable string.
 */
export type ResolveReason =
  | 'registry_unavailable' // no `latestStable` on the observation
  | 'pinned_within_max' // pin matched, current ≤ max
  | 'pinned_above_max' // pin matched, current > max
  | 'banned_violated' // ban matched, replacement configured
  | 'banned_unresolved_replacement' // ban matched but no replacement configured
  | 'deferred_until_future' // defer matches, until > now
  | 'deferred_overdue' // defer matches, until ≤ now → propagates as `investigate`
  | 'preferred_no_status_change' // prefer matches; status unaffected
  | 'unconstrained'; // no rule matched; status comes from registry/status engine

/**
 * Provenance for the rule that drove a decision. Kept separate from the
 * engine-wide `Evidence` union on purpose: a rulebook hit is policy, not
 * registry/manifest/audit evidence, and must never be presented as such.
 */
export interface RuleEvidence {
  readonly rule: 'pinned' | 'banned' | 'deferred' | 'preferred';
  readonly detail: string;
}

/**
 * The single resolved target for one dependency. The resolver produces one
 * of these per `(dependency, rulebook)` pair. The engine then merges this
 * into the analyzer's finding stream.
 */
export interface ResolvedTarget {
  readonly dependencyId: string;
  readonly selectorHits: {
    readonly pinned: readonly PinEntry[];
    readonly banned: readonly BanEntry[];
    readonly deferred: readonly DeferEntry[];
    readonly preferred: readonly PreferEntry[];
  };
  /** The version the rulebook wants, or `undefined` if no rule constrains it. */
  readonly targetVersion: VersionRange | undefined;
  /** Whether the evaluated version satisfies the rulebook. */
  readonly satisfies: boolean;
  /** Reason for the decision — stable identifier + human detail. */
  readonly reason: ResolveReason;
  readonly detail: string;
  /** Which rule fired and why. Empty for `unconstrained`/`registry_unavailable`. */
  readonly ruleEvidence: readonly RuleEvidence[];
}

// ── Selector matching ────────────────────────────────────────────────────

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Translate a rulebook wildcard pattern into an anchored RegExp. */
function patternToRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'; // `**` crosses `/`
        i++;
      } else {
        source += '[^/]*'; // `*` stays within one path segment
      }
    } else {
      source += ch.replace(REGEX_SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * Validate a `PackageSelector` against a `(ecosystem, name)` pair.
 *
 * Wildcard semantics:
 *   - `namePattern` uses `*` (any non-`/` sequence) and `**` (any sequence).
 *   - `selector.ecosystem` is exact match (case-insensitive, trimmed).
 *   - `selector.name` is exact match (case-insensitive, trimmed).
 *   - At least one of `name`, `namePattern`, `ecosystem` must be present.
 *   - An empty selector matches nothing.
 *   - When both `name` and `namePattern` are present, either may match.
 *   - An `ecosystem`-only selector matches every package in that ecosystem.
 */
export function matchesSelector(
  selector: PackageSelector,
  ecosystem: string,
  name: string,
): boolean {
  const hasEco = hasValue(selector.ecosystem);
  const hasName = hasValue(selector.name);
  const hasPattern = hasValue(selector.namePattern);

  if (!hasEco && !hasName && !hasPattern) {
    return false; // empty selector matches nothing
  }

  if (hasEco && selector.ecosystem?.trim().toLowerCase() !== ecosystem.trim().toLowerCase()) {
    return false;
  }

  if (!hasName && !hasPattern) {
    return true; // ecosystem-only selector
  }

  const nameOk = hasName && selector.name?.trim().toLowerCase() === name.trim().toLowerCase();
  const patternOk = hasPattern && patternToRegex(selector.namePattern ?? '').test(name);
  return nameOk === true || patternOk === true;
}

/**
 * Find all rulebook entries that match a `(ecosystem, name)` pair.
 * Pure function. Used by the advisor to filter the rulebook by context.
 */
export function findRuleMatches(
  rulebook: Rulebook,
  ecosystem: string,
  name: string,
): {
  readonly pinned: readonly PinEntry[];
  readonly banned: readonly BanEntry[];
  readonly deferred: readonly DeferEntry[];
  readonly preferred: readonly PreferEntry[];
} {
  return {
    pinned: rulebook.pinned.filter((e) => matchesSelector(e.selector, ecosystem, name)),
    banned: rulebook.banned.filter((e) => matchesSelector(e.selector, ecosystem, name)),
    deferred: rulebook.deferred.filter((e) => matchesSelector(e.selector, ecosystem, name)),
    preferred: rulebook.preferred.filter((e) => matchesSelector(e.selector, ecosystem, name)),
  };
}

// ── Range parsing ────────────────────────────────────────────────────────

/**
 * The structured form of a rulebook `VersionRange`. The grammar is the
 * semver-range subset the engine already understands — it is intentionally
 * NOT a generic semver-range parser.
 */
export type ParsedRange =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'caret'; readonly version: string }
  | { readonly kind: 'tilde'; readonly version: string }
  | {
      readonly kind: 'comparator';
      readonly op: '>=' | '<=' | '>' | '<' | '=';
      readonly version: string;
    }
  | { readonly kind: 'and'; readonly ranges: readonly ParsedRange[] }
  | { readonly kind: 'or'; readonly ranges: readonly ParsedRange[] };

export class RangeParseError extends Error {
  constructor(
    public readonly input: string,
    public readonly position: number,
    message: string,
  ) {
    super(`Invalid version range '${input}' at position ${position}: ${message}`);
    this.name = 'RangeParseError';
  }
}

/** `1.2.3`, `1.2`, `1`, with an optional prerelease suffix. */
const VERSION_RE = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function mustVersion(raw: string, input: string, position: number): string {
  const version = raw.trim();
  if (!VERSION_RE.test(version)) {
    throw new RangeParseError(input, position, `'${raw}' is not a valid version`);
  }
  return version;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=)(.*)$/;

function parseToken(token: string, position: number, input: string): ParsedRange {
  if (token.startsWith('^')) {
    return { kind: 'caret', version: mustVersion(token.slice(1), input, position) };
  }
  if (token.startsWith('~')) {
    return { kind: 'tilde', version: mustVersion(token.slice(1), input, position) };
  }
  const comparator = COMPARATOR_RE.exec(token);
  if (comparator) {
    const op = comparator[1];
    const version = comparator[2];
    if (op !== undefined && version !== undefined) {
      return {
        kind: 'comparator',
        op: op as '>=' | '<=' | '>' | '<' | '=',
        version: mustVersion(version, input, position),
      };
    }
  }
  return { kind: 'exact', version: mustVersion(token, input, position) };
}

function parseConjunction(part: string, input: string): ParsedRange {
  const tokens = part.trim().split(/\s+/);
  const ranges: ParsedRange[] = [];
  let searched = 0;
  for (const token of tokens) {
    const at = part.indexOf(token, searched);
    searched = at + token.length;
    ranges.push(parseToken(token, at, input));
  }
  if (ranges.length === 1) {
    return ranges[0] ?? { kind: 'exact', version: '0' };
  }
  return { kind: 'and', ranges };
}

/**
 * Parse a `VersionRange` string into a structured range.
 *
 * Grammar:
 *   - exact:      `1.2.3`
 *   - caret:      `^1.2.3`
 *   - tilde:      `~1.2.3`
 *   - comparator: `>=1.2.3` (also `<=`, `>`, `<`, `=`)
 *   - AND:        `>=1.2.3 <2.0.0` (whitespace-separated)
 *   - OR:         `^1.2.3 || ^2.0.0`
 *
 * Invalid inputs throw `RangeParseError`.
 */
export function parseRange(input: string): ParsedRange {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new RangeParseError(input, 0, 'empty range');
  }
  const orParts = trimmed.split('||');
  if (orParts.length > 1) {
    const ranges = orParts.map((part) => parseConjunction(part, input));
    return { kind: 'or', ranges };
  }
  return parseConjunction(trimmed, input);
}

// ── Range evaluation ─────────────────────────────────────────────────────

function versionParts(version: string): number[] {
  return (
    version
      .split('-')[0]
      ?.split('.')
      .map((segment) => Number.parseInt(segment, 10)) ?? []
  );
}

/** Upper bound (exclusive) for a caret range, per semver caret rules. */
function caretUpper(version: string): string {
  const [major = 0, minor = 0, patch = 0] = versionParts(version);
  if (major > 0) return `${major + 1}.0.0`;
  if (minor > 0) return `0.${minor + 1}.0`;
  return `0.0.${patch + 1}`;
}

/** Upper bound (exclusive) for a tilde range. */
function tildeUpper(version: string): string {
  const parts = versionParts(version);
  const [major = 0, minor = 0] = parts;
  if (parts.length >= 2) return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

/**
 * Check whether `version` satisfies `range`. Pure function.
 * Re-uses `compareVersions` from `policy/status.ts` as the single semver
 * comparison primitive — including its prerelease tie-break semantics.
 */
export function satisfiesRange(version: string, range: ParsedRange): boolean {
  switch (range.kind) {
    case 'exact':
      return compareVersions(version, range.version) === 0;
    case 'comparator': {
      const cmp = compareVersions(version, range.version);
      switch (range.op) {
        case '>=':
          return cmp >= 0;
        case '<=':
          return cmp <= 0;
        case '>':
          return cmp > 0;
        case '<':
          return cmp < 0;
        case '=':
          return cmp === 0;
      }
      return false;
    }
    case 'caret':
      return (
        compareVersions(version, range.version) >= 0 &&
        compareVersions(version, caretUpper(range.version)) < 0
      );
    case 'tilde':
      return (
        compareVersions(version, range.version) >= 0 &&
        compareVersions(version, tildeUpper(range.version)) < 0
      );
    case 'and':
      return range.ranges.every((sub) => satisfiesRange(version, sub));
    case 'or':
      return range.ranges.some((sub) => satisfiesRange(version, sub));
  }
  return false;
}

function trySatisfies(version: string, rangeString: string): boolean | undefined {
  try {
    return satisfiesRange(version, parseRange(rangeString));
  } catch {
    return undefined; // malformed rulebook range — caller decides semantics
  }
}

// ── Resolution ───────────────────────────────────────────────────────────

const NO_HITS = {
  pinned: [] as readonly PinEntry[],
  banned: [] as readonly BanEntry[],
  deferred: [] as readonly DeferEntry[],
  preferred: [] as readonly PreferEntry[],
};

/**
 * Resolve a single dependency against the rulebook. Pure: same inputs +
 * same `now` → same output. See the decision order in the module header.
 *
 * @param dep      Enriched dependency. A missing `latestStable` short-circuits
 *                 to `registry_unavailable` — the resolver never fabricates.
 * @param rulebook Optional rulebook. `undefined` → `unconstrained`.
 * @param now      Reference time for `deferred.until`; the caller passes it
 *                 to keep this function deterministic.
 */
export function resolveDependency(
  dep: DependencyObservation,
  rulebook: Rulebook | undefined,
  now: Date,
): ResolvedTarget {
  const hits = rulebook ? findRuleMatches(rulebook, dep.ecosystem, dep.name) : NO_HITS;
  const base = { dependencyId: dep.id, selectorHits: hits };

  // 1. Never evaluate policy against fabricated facts.
  if (dep.latestStable === undefined) {
    return {
      ...base,
      targetVersion: undefined,
      satisfies: false,
      reason: 'registry_unavailable',
      detail: `no registry evidence for ${dep.ecosystem}:${dep.name}; refusing to fabricate`,
      ruleEvidence: [],
    };
  }

  // 2. Bans override every other rule.
  const ban = hits.banned[0];
  if (ban !== undefined) {
    const hasReplacement = ban.replacement !== undefined;
    return {
      ...base,
      targetVersion: ban.replacement?.minVersion,
      satisfies: false,
      reason: hasReplacement ? 'banned_violated' : 'banned_unresolved_replacement',
      detail: hasReplacement
        ? `banned (${ban.reason}); replace with ${ban.replacement?.ecosystem}:${ban.replacement?.name}`
        : `banned (${ban.reason}); no replacement configured`,
      ruleEvidence: [{ rule: 'banned', detail: ban.reason }],
    };
  }

  // 3. Pins cap the acceptable version range.
  const pin = hits.pinned[0];
  if (pin !== undefined) {
    const locked = dep.locked ?? dep.installed;
    const evaluated = locked ?? dep.latestStable;
    const evaluatedVia =
      dep.locked !== undefined
        ? 'locked'
        : dep.installed !== undefined
          ? 'installed'
          : 'latestStable';
    const satisfies = trySatisfies(evaluated, pin.max);
    return {
      ...base,
      targetVersion: pin.max,
      satisfies: satisfies ?? false,
      reason: satisfies === true ? 'pinned_within_max' : 'pinned_above_max',
      detail:
        satisfies === undefined
          ? `pin max '${pin.max}' is not a parseable range; evaluated ${evaluated} (${evaluatedVia})`
          : `pin max ${pin.max}; evaluated ${evaluated} (${evaluatedVia})`,
      ruleEvidence: [{ rule: 'pinned', detail: pin.reason }],
    };
  }

  // 4. Defers suppress upgrade pressure until their window closes.
  const defer = hits.deferred[0];
  if (defer !== undefined) {
    const untilMs = Date.parse(defer.until);
    const active = !Number.isNaN(untilMs) && untilMs > now.getTime();
    return {
      ...base,
      targetVersion: undefined,
      satisfies: active,
      reason: active ? 'deferred_until_future' : 'deferred_overdue',
      detail: active
        ? `deferred until ${defer.until} (${defer.reason})`
        : `defer window closed at ${defer.until} (${defer.reason})`,
      ruleEvidence: [{ rule: 'deferred', detail: defer.reason }],
    };
  }

  // 5. Preferences never change status; the advisor reads them for ranking.
  const prefer = hits.preferred[0];
  if (prefer !== undefined) {
    return {
      ...base,
      targetVersion: undefined,
      satisfies: true,
      reason: 'preferred_no_status_change',
      detail: `preferred in context: ${prefer.context}`,
      ruleEvidence: [{ rule: 'preferred', detail: prefer.context }],
    };
  }

  // 6. Nothing matched.
  return {
    ...base,
    targetVersion: undefined,
    satisfies: true,
    reason: 'unconstrained',
    detail: 'no rulebook entry matched',
    ruleEvidence: [],
  };
}

const NON_REGISTRY_SOURCES: ReadonlySet<string> = new Set(['path', 'git', 'system']);

/**
 * Resolve an entire observation list. Non-registry sources (path, git,
 * system) are always `unconstrained` — the rulebook only addresses registry
 * packages.
 */
export function resolveDependencies(
  dependencies: readonly DependencyObservation[],
  rulebook: Rulebook | undefined,
  now: Date,
): readonly ResolvedTarget[] {
  return dependencies.map((dep) => {
    if (NON_REGISTRY_SOURCES.has(dep.sourceType)) {
      return {
        dependencyId: dep.id,
        selectorHits: NO_HITS,
        targetVersion: undefined,
        satisfies: true,
        reason: 'unconstrained',
        detail: `sourceType '${dep.sourceType}' is not rulebook-addressable`,
        ruleEvidence: [],
      } satisfies ResolvedTarget;
    }
    return resolveDependency(dep, rulebook, now);
  });
}

// ── Public aggregator used by the analyzer (contract, not yet wired) ─────

/**
 * A "summary" of a rulebook across the project. The advisor (LLM) reads
 * this to know what to recommend; the analyzer adds these as evidence
 * to its findings. The resolver is the only writer.
 */
export interface RulebookSummary {
  readonly totalPinned: number;
  readonly totalBanned: number;
  readonly totalDeferred: number;
  readonly totalPreferred: number;
  readonly packageManagerPreference: { readonly ecosystem: string; readonly manager: string }[];
  readonly violations: readonly {
    readonly dependencyId: string;
    readonly reason: ResolveReason;
    readonly detail: string;
  }[];
  /** Human-readable snapshot of the rulebook, ≤ 4 KiB. */
  readonly digest: string;
}

/**
 * Build a `RulebookSummary` from a list of resolved targets + the rulebook.
 * Pure function. The digest is the only string the LLM is allowed to read
 * verbatim; it MUST NOT contain `latestStable`/version numbers from the
 * registry (those would be a fabrication risk if the rulebook is stale).
 *
 * Contract only — not implemented yet; nothing depends on it today.
 */
export type SummarizeRulebook = (
  rulebook: Rulebook,
  resolved: readonly ResolvedTarget[],
) => RulebookSummary;
