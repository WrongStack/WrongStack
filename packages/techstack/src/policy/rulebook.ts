/**
 * TechStack — Project Rulebook.
 *
 * A Rulebook is a deterministic, project-local policy document that overrides
 * or supplements the registry-driven defaults produced by the TechStack engine.
 * It exists so that the LLM (`advisor/`) never has to invent policies like
 * "we pin React 18 because of the EOL fork" — that intent lives in this file,
 * authored by humans, and consumed by the Resolver as ground truth.
 *
 * Design principles (mirrors SDD §1: "deterministic engines for facts, agents for interpretation"):
 *  - The rulebook is **data**, not code. It is a JSON file under the target project.
 *  - The rulebook is **read-only** to the engine. The engine proposes changes; humans apply them.
 *  - The rulebook never sets `latestStable` — that field is always registry evidence.
 *  - The rulebook only constrains: pin, ban, prefer, defer, and provides an
 *    `advisorHints` bag for the LLM to read (not write).
 *
 * File location (resolution order, first hit wins):
 *   1. Path passed to `loadRulebook(targetRoot, overridePath)`
 *   2. `<targetRoot>/.wrongstack/techstack.rulebook.json`
 *   3. `<targetRoot>/.wrongstack/techstack.rulebook.yaml`
 *   4. No rulebook → Resolver falls back to "no overrides" mode.
 *
 * @see docs/archive/specs/techstack-sdd.md §1, §7
 * @see packages/techstack/src/policy/resolver.ts — the consumer of this contract.
 */
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';

export { RULEBOOK_JSON_SCHEMA } from './rulebook-json-schema.js';

// ── Version range syntax ──────────────────────────────────────────────────
//
// `pinned[].max`, `banned[].since`, `preferred[].min` are version ranges.
// We use the semver-range subset that is already understood by the engine
// (see `policy/status.ts#compareVersions`): caret/tilde, comparators, and
// exact versions. The grammar and parser are NOT defined here — they are
// implemented in the resolver. This contract only constrains the SHAPE.

/** A semver-range string. Resolved by `policy/resolver.ts#parseRange`. */
export type VersionRange = string & { readonly __brand: 'VersionRange' };

/** ISO 8601 timestamp. Used for `defer.until`, `banned.since`, etc. */
export type IsoDateTime = string & { readonly __brand: 'IsoDateTime' };

/** Wildcard matcher over `(ecosystem, name)` pairs. */
export interface PackageSelector {
  readonly ecosystem?: string | undefined;
  readonly name?: string | undefined;
  /**
   * Wildcard glob over the package name. `*` matches any sequence of characters
   * EXCEPT `/`; `**` matches across path separators. The resolver pins this
   * down to a concrete matching function.
   */
  readonly namePattern?: string | undefined;
}

// ── Entry shapes ──────────────────────────────────────────────────────────

/**
 * Pin a package to a maximum version (or version range). Updates beyond
 * `max` are flagged as `blocked_by_constraints` (not `update_available_*`).
 * The reason is surfaced in advisor output and analyzer rationale.
 */
export interface PinEntry {
  readonly selector: PackageSelector;
  readonly max: VersionRange;
  readonly reason: string;
  /** Review-after date. After this date the rulebook emits a `investigate` finding. */
  readonly reviewAfter?: IsoDateTime | undefined;
}

/**
 * Ban a package entirely. The resolver emits a `replace` finding using
 * `replacement` as the migration target when present.
 */
export interface BanEntry {
  readonly selector: PackageSelector;
  readonly reason: string;
  readonly replacement?: ReplacementEntry | undefined;
  /** When the ban took effect; advisory findings are not emitted for usages before this date. */
  readonly since?: IsoDateTime | undefined;
}

/**
 * Replacement target for a banned package. The Resolver emits a `replace`
 * finding with `action: 'replace'` and `breakingRisk` derived from the
 * major-version gap between current and replacement.
 */
export interface ReplacementEntry {
  readonly ecosystem: string;
  readonly name: string;
  readonly minVersion?: VersionRange | undefined;
  readonly notes?: string | undefined;
}

/**
 * Defer an upgrade — the package is intentionally out-of-date and the
 * upgrade is scheduled. The Resolver tags affected dependencies as
 * `deferred_intentional` (a new finding kind) and suppresses
 * `update_available_*` findings until `until`.
 */
export interface DeferEntry {
  readonly selector: PackageSelector;
  readonly until: IsoDateTime;
  readonly reason: string;
  /** Reference key (e.g. "JIRA-1234") for traceability. */
  readonly ticket?: string | undefined;
}

/**
 * Preferred package — when multiple implementations are valid, the advisor
 * prefers this one. The Resolver does not change `current` status; only the
 * advisor's ranking function reads this.
 */
export interface PreferEntry {
  readonly selector: PackageSelector;
  readonly context: string;
  /** Optional replacement for a sibling package — e.g. "prefer `vitest` over `jest`". */
  readonly deprecates?: PackageSelector | undefined;
}

/**
 * Top-level package manager preference. The Resolver cross-references this
 * with `Workspace.packageManager` and emits a finding when a workspace
 * disagrees with the rulebook.
 */
export interface PackageManagerPreference {
  readonly npm?: string | undefined; // e.g. "pnpm"
  readonly python?: string | undefined; // e.g. "uv"
  readonly rust?: string | undefined; // e.g. "cargo"
  readonly go?: string | undefined; // e.g. "go modules"
  readonly dotnet?: string | undefined;
  readonly php?: string | undefined;
  readonly dart?: string | undefined;
  readonly java?: string | undefined; // maven or gradle
  readonly ruby?: string | undefined;
  readonly swift?: string | undefined;
  readonly elixir?: string | undefined;
}

// ── Top-level rulebook document ───────────────────────────────────────────

/** Schema version of the rulebook on disk. Bump on breaking changes. */
export type RulebookSchemaVersion = '1';

export interface Rulebook {
  readonly schemaVersion: RulebookSchemaVersion;
  readonly projectId?: string | undefined;
  readonly pinned: readonly PinEntry[];
  readonly banned: readonly BanEntry[];
  readonly deferred: readonly DeferEntry[];
  readonly preferred: readonly PreferEntry[];
  readonly packageManager?: PackageManagerPreference | undefined;
  /**
   * Free-form context for the LLM advisor. The Resolver never reads this;
   * it is exposed verbatim to the advisor at suggestion time.
   * Constraints: max 8 KiB total, no execution on read.
   */
  readonly advisorHints?: string | undefined;
}

// ── Load + parse ─────────────────────────────────────────────────────────

/** Result of a rulebook load attempt. Never throws for "missing" — only for "malformed". */
export type LoadRulebookResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly rulebook: Rulebook; readonly source: string }
  | { readonly kind: 'malformed'; readonly source: string; readonly errors: readonly string[] };

/**
 * In-memory file system abstract for the rulebook loader. Tests inject a
 * deterministic map; production uses `node:fs/promises`.
 */
export interface RulebookFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly size: number }>;
}

/** Default file system backed by `node:fs/promises`. */
export const defaultRulebookFileSystem: RulebookFileSystem = {
  async exists(path) {
    try {
      await fsAccess(path);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(path) {
    return fsReadFile(path, 'utf8');
  },
  async stat(path) {
    const stats = await fsStat(path);
    return { size: stats.size };
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidIsoDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

const RULEBOOK_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'pinned',
  'banned',
  'deferred',
  'preferred',
  'packageManager',
  'advisorHints',
]);

const PACKAGE_MANAGER_KEYS = new Set([
  'npm',
  'python',
  'rust',
  'go',
  'dotnet',
  'php',
  'dart',
  'java',
  'ruby',
  'swift',
  'elixir',
]);

function selectorHasAtLeastOneField(selector: unknown): boolean {
  if (!isPlainObject(selector)) return false;
  const values = [selector.ecosystem, selector.name, selector.namePattern];
  return (
    values.every((value) => value === undefined || isNonEmptyString(value)) &&
    values.some(isNonEmptyString)
  );
}

function reportUnknownProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown property: ${key}`);
  }
}

const SELECTOR_KEYS = new Set(['ecosystem', 'name', 'namePattern']);
const PIN_KEYS = new Set(['selector', 'max', 'reason', 'reviewAfter']);
const BAN_KEYS = new Set(['selector', 'reason', 'replacement', 'since']);
const REPLACEMENT_KEYS = new Set(['ecosystem', 'name', 'minVersion', 'notes']);
const DEFER_KEYS = new Set(['selector', 'until', 'reason', 'ticket']);
const PREFER_KEYS = new Set(['selector', 'context', 'deprecates']);

/**
 * Locate and parse a rulebook from the target project tree.
 *
 * Resolution order:
 *   1. `overridePath` (if provided and exists)
 *   2. `<targetRoot>/.wrongstack/techstack.rulebook.json`
 *   3. `<targetRoot>/.wrongstack/techstack.rulebook.yaml`
 *   4. `absent`
 *
 * JSON is fully supported. YAML files are detected but reported as
 * `malformed` with an explanatory error — the vendored minimal YAML parser
 * is scheduled for P3.1 (`adapters/parse-utils.ts`), not yet available.
 *
 * @param targetRoot Absolute path to the analyzed project root.
 * @param overridePath Optional explicit path to a rulebook file.
 * @param io File system abstraction; default uses real fs. Tests inject a mock.
 */
export async function loadRulebook(
  targetRoot: string,
  overridePath?: string,
  io: RulebookFileSystem = defaultRulebookFileSystem,
): Promise<LoadRulebookResult> {
  const defaultPaths = [
    `${targetRoot}/.wrongstack/techstack.rulebook.json`,
    `${targetRoot}/.wrongstack/techstack.rulebook.yaml`,
  ];
  const candidates =
    overridePath !== undefined && overridePath.trim() !== ''
      ? [overridePath, ...defaultPaths]
      : defaultPaths;

  for (const candidate of candidates) {
    let exists = false;
    try {
      exists = await io.exists(candidate);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    if (/\.ya?ml$/i.test(candidate)) {
      return {
        kind: 'malformed',
        source: candidate,
        errors: [
          'YAML rulebooks are not supported yet — use .wrongstack/techstack.rulebook.json (vendored YAML parser lands with P3.1 parse-utils)',
        ],
      };
    }

    let raw: string;
    try {
      raw = await io.readFile(candidate);
    } catch (error) {
      return {
        kind: 'malformed',
        source: candidate,
        errors: [`unable to read file: ${String(error)}`],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) {
      return {
        kind: 'malformed',
        source: candidate,
        errors: [`JSON parse failed: ${String(error)}`],
      };
    }

    const errors = validateRulebook(parsed);
    if (errors.length > 0) {
      return { kind: 'malformed', source: candidate, errors };
    }
    const rawRulebook = parsed as Partial<Rulebook> & { schemaVersion: '1' };
    const rulebook: Rulebook = {
      ...rawRulebook,
      pinned: rawRulebook.pinned ?? [],
      banned: rawRulebook.banned ?? [],
      deferred: rawRulebook.deferred ?? [],
      preferred: rawRulebook.preferred ?? [],
    };
    return { kind: 'loaded', rulebook, source: candidate };
  }

  return { kind: 'absent' };
}

/**
 * Validate a parsed rulebook object against `Rulebook`. Returns the list of
 * human-readable errors. Empty list means valid.
 *
 * Schema invariants (any violation is an error):
 *  - `schemaVersion === '1'`
 *  - `pinned[].max` is a non-empty version range
 *  - `pinned[].reason` is non-empty
 *  - `banned[].reason` is non-empty
 *  - `deferred[].until` is a valid ISO 8601 timestamp and in the future
 *  - `advisorHints` ≤ 8192 bytes when serialized
 *  - Each `selector` reaches at least one of `name`, `namePattern`, `ecosystem`
 *  - At least one of `pinned`, `banned`, `deferred`, `preferred`,
 *    `packageManager`, `advisorHints` must be present (a totally empty
 *    rulebook is treated as "no rulebook" — see `LoadRulebookResult.kind`).
 */
export function validateRulebook(input: unknown): readonly string[] {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return ['rulebook must be a JSON object'];
  }

  for (const key of Object.keys(input)) {
    if (!RULEBOOK_KEYS.has(key)) errors.push(`unknown top-level property: ${key}`);
  }

  if (input.schemaVersion !== '1') {
    errors.push(`schemaVersion must be '1', got ${JSON.stringify(input.schemaVersion)}`);
  }

  if (input.projectId !== undefined && !isNonEmptyString(input.projectId)) {
    errors.push('projectId must be a non-empty string');
  }

  const hasAnySection =
    [input.pinned, input.banned, input.deferred, input.preferred].some(
      (section) => Array.isArray(section) && section.length > 0,
    ) ||
    (isPlainObject(input.packageManager) && Object.keys(input.packageManager).length > 0) ||
    isNonEmptyString(input.advisorHints);
  if (!hasAnySection) {
    errors.push(
      'rulebook must declare at least one of pinned/banned/deferred/preferred/packageManager/advisorHints',
    );
  }

  if (input.pinned !== undefined) {
    if (!Array.isArray(input.pinned)) {
      errors.push('pinned must be an array');
    } else {
      input.pinned.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`pinned[${index}] must be an object`);
          return;
        }
        reportUnknownProperties(entry, PIN_KEYS, `pinned[${index}]`, errors);
        if (isPlainObject(entry.selector)) {
          reportUnknownProperties(
            entry.selector,
            SELECTOR_KEYS,
            `pinned[${index}].selector`,
            errors,
          );
        }
        if (!selectorHasAtLeastOneField(entry.selector)) {
          errors.push(
            `pinned[${index}].selector must set at least one of name/namePattern/ecosystem`,
          );
        }
        if (!isNonEmptyString(entry.max)) {
          errors.push(`pinned[${index}].max must be a non-empty version range`);
        }
        if (!isNonEmptyString(entry.reason)) {
          errors.push(`pinned[${index}].reason must be non-empty`);
        }
        if (
          entry.reviewAfter !== undefined &&
          (typeof entry.reviewAfter !== 'string' || !isValidIsoDateTime(entry.reviewAfter))
        ) {
          errors.push(`pinned[${index}].reviewAfter must be a valid ISO 8601 timestamp`);
        }
      });
    }
  }

  if (input.banned !== undefined) {
    if (!Array.isArray(input.banned)) {
      errors.push('banned must be an array');
    } else {
      input.banned.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`banned[${index}] must be an object`);
          return;
        }
        reportUnknownProperties(entry, BAN_KEYS, `banned[${index}]`, errors);
        if (isPlainObject(entry.selector)) {
          reportUnknownProperties(
            entry.selector,
            SELECTOR_KEYS,
            `banned[${index}].selector`,
            errors,
          );
        }
        if (!selectorHasAtLeastOneField(entry.selector)) {
          errors.push(
            `banned[${index}].selector must set at least one of name/namePattern/ecosystem`,
          );
        }
        if (!isNonEmptyString(entry.reason)) {
          errors.push(`banned[${index}].reason must be non-empty`);
        }
        if (
          entry.since !== undefined &&
          (typeof entry.since !== 'string' || !isValidIsoDateTime(entry.since))
        ) {
          errors.push(`banned[${index}].since must be a valid ISO 8601 timestamp`);
        }
        if (entry.replacement !== undefined) {
          if (!isPlainObject(entry.replacement)) {
            errors.push(`banned[${index}].replacement must be an object`);
          } else {
            reportUnknownProperties(
              entry.replacement,
              REPLACEMENT_KEYS,
              `banned[${index}].replacement`,
              errors,
            );
            if (!isNonEmptyString(entry.replacement.ecosystem)) {
              errors.push(`banned[${index}].replacement.ecosystem must be non-empty`);
            }
            if (!isNonEmptyString(entry.replacement.name)) {
              errors.push(`banned[${index}].replacement.name must be non-empty`);
            }
            if (
              entry.replacement.minVersion !== undefined &&
              typeof entry.replacement.minVersion !== 'string'
            ) {
              errors.push(`banned[${index}].replacement.minVersion must be a string`);
            }
            if (
              entry.replacement.notes !== undefined &&
              typeof entry.replacement.notes !== 'string'
            ) {
              errors.push(`banned[${index}].replacement.notes must be a string`);
            }
          }
        }
      });
    }
  }

  if (input.deferred !== undefined) {
    if (!Array.isArray(input.deferred)) {
      errors.push('deferred must be an array');
    } else {
      input.deferred.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`deferred[${index}] must be an object`);
          return;
        }
        reportUnknownProperties(entry, DEFER_KEYS, `deferred[${index}]`, errors);
        if (isPlainObject(entry.selector)) {
          reportUnknownProperties(
            entry.selector,
            SELECTOR_KEYS,
            `deferred[${index}].selector`,
            errors,
          );
        }
        if (!selectorHasAtLeastOneField(entry.selector)) {
          errors.push(
            `deferred[${index}].selector must set at least one of name/namePattern/ecosystem`,
          );
        }
        if (!isNonEmptyString(entry.reason)) {
          errors.push(`deferred[${index}].reason must be non-empty`);
        }
        if (typeof entry.until !== 'string' || !isValidIsoDateTime(entry.until)) {
          errors.push(`deferred[${index}].until must be a valid ISO 8601 timestamp`);
        } else if (Date.parse(entry.until) <= Date.now()) {
          errors.push(`deferred[${index}].until must be in the future`);
        }
      });
    }
  }

  if (input.preferred !== undefined) {
    if (!Array.isArray(input.preferred)) {
      errors.push('preferred must be an array');
    } else {
      input.preferred.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`preferred[${index}] must be an object`);
          return;
        }
        reportUnknownProperties(entry, PREFER_KEYS, `preferred[${index}]`, errors);
        if (isPlainObject(entry.selector)) {
          reportUnknownProperties(
            entry.selector,
            SELECTOR_KEYS,
            `preferred[${index}].selector`,
            errors,
          );
        }
        if (!selectorHasAtLeastOneField(entry.selector)) {
          errors.push(
            `preferred[${index}].selector must set at least one of name/namePattern/ecosystem`,
          );
        }
        if (!isNonEmptyString(entry.context)) {
          errors.push(`preferred[${index}].context must be non-empty`);
        }
        if (entry.deprecates !== undefined && !selectorHasAtLeastOneField(entry.deprecates)) {
          errors.push(`preferred[${index}].deprecates must be a valid selector`);
        }
        if (isPlainObject(entry.deprecates)) {
          reportUnknownProperties(
            entry.deprecates,
            SELECTOR_KEYS,
            `preferred[${index}].deprecates`,
            errors,
          );
        }
      });
    }
  }

  if (input.packageManager !== undefined) {
    if (!isPlainObject(input.packageManager)) {
      errors.push('packageManager must be an object');
    } else {
      for (const [key, value] of Object.entries(input.packageManager)) {
        if (!PACKAGE_MANAGER_KEYS.has(key)) {
          errors.push(`packageManager contains unknown property: ${key}`);
        } else if (typeof value !== 'string') {
          errors.push(`packageManager.${key} must be a string`);
        }
      }
    }
  }

  if (input.advisorHints !== undefined) {
    if (typeof input.advisorHints !== 'string') {
      errors.push('advisorHints must be a string');
    } else if (new TextEncoder().encode(JSON.stringify(input.advisorHints)).length > 8192) {
      errors.push('advisorHints exceeds the 8192-byte limit');
    }
  }

  return errors;
}

// ── Exports to be implemented by the resolver ─────────────────────────────

/**
 * Match a `(ecosystem, name)` pair against a PackageSelector.
 * Pure function. Symmetric: `matchesSelector(selector, ecosystem, name)`.
 */
export type MatchesSelector = (
  selector: PackageSelector,
  ecosystem: string,
  name: string,
) => boolean;

/**
 * Brand-construction helper for the runtime. Tests that build fixtures
 * call this so branded types stay opaque.
 */
export const asVersionRange = (s: string): VersionRange => s as VersionRange;
export const asIsoDateTime = (s: string): IsoDateTime => s as IsoDateTime;
