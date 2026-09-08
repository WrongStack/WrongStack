/**
 * Deterministic file-pattern → roster-role triggers.
 *
 * ## Why this exists
 *
 * The roster holds 75 specialists and the measured usage is one role — the
 * reviewer — taking better than nine spawns in ten. The reason is not that the
 * dispatcher picks badly (that was measured and fixed on 2026-08-10); it is
 * that the reviewer is the only role anything *automatically* asks for. Every
 * other specialist waits for a leader to remember it exists, and roughly once a
 * month one does.
 *
 * So this layer does not try to be smarter about routing. It fires the same way
 * auto-review does — a file changed, therefore a specialist has something to
 * say — for a handful of cases where the mapping is not a judgement call at
 * all. A lockfile changed: the dependency agent has work. A migration landed:
 * the database agent does.
 *
 * ## Deliberately not a model call
 *
 * Every rule here is a glob. No classifier, no scoring, no confidence
 * threshold. A trigger that occasionally has to be tuned by editing a pattern
 * is worth far more than one that is right 90% of the time and cannot be
 * explained the other 10%, because this thing spends money on the user's behalf
 * without being asked. Routing ambiguity belongs in `dispatchAgent`, which is
 * already good at it; this file's whole job is to be boring.
 */

import type { Config } from '../types/config.js';
import { matchAny } from '../utils/glob-match.js';

/** One trigger: paths that, once settled, mean a given specialist has work. */
export interface SpecialistTriggerRule {
  /** Roster role id to spawn. */
  role: string;
  /** Glob patterns, matched against repo-relative POSIX paths. */
  match: string[];
  /**
   * Why this role was woken, put verbatim into the task it is assigned. The
   * agent otherwise has to guess what about the change concerns it.
   */
  reason: string;
  /** Cost tier for the worker. Defaults to `budget` — see below. */
  tier?: 'budget' | 'standard' | 'premium' | undefined;
}

/**
 * The shipped rules.
 *
 * Two tests a rule has to pass, and length is not one of them:
 *
 *  1. **The mapping needs no judgement.** A Dockerfile pattern pointing at
 *     `devops` is a fact about the file, not an opinion about the change.
 *     Anything needing a reading of *what* changed belongs to `dispatchAgent`.
 *  2. **It cannot fire on ordinary source churn.** This is why no `frontend`
 *     rule matches every `.tsx` file: in a repo whose TUI is React, that rule
 *     fires every session, and a specialist that always has an opinion is
 *     background noise that crowds the per-session cap out from under the rules
 *     that only speak when something genuinely happened.
 *
 * Several rules below are inert in any one repository — nothing here is written
 * in Swift. That is fine and intended: the plugin ships to every project, and a
 * rule that costs nothing where it does not apply is worth having where it does.
 *
 * The default tier is `budget` throughout. These workers are non-blocking
 * background opinions, so a slower cheap model costs nothing but wall-clock
 * that nobody is waiting on — the same reasoning the `spawn_subagent` tool
 * already gives for tiering async work.
 */
export const DEFAULT_SPECIALIST_TRIGGERS: readonly SpecialistTriggerRule[] = Object.freeze([
  {
    role: 'dependency',
    match: [
      '**/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '**/requirements*.txt',
      '**/Cargo.toml',
      '**/go.mod',
    ],
    reason:
      'Dependency manifests or the lockfile changed. Check what actually moved: new or removed packages, version jumps, transitive changes, licence and supply-chain risk, and whether the lockfile agrees with the manifests.',
  },
  {
    role: 'database',
    match: ['**/migrations/**', '**/*.sql', '**/schema.prisma'],
    reason:
      'A schema or migration changed. Check reversibility, whether it locks a table on a live database, index coverage for the queries that will hit it, and whether existing rows survive the change.',
  },
  {
    role: 'i18n',
    match: ['**/locales/**', '**/i18n/**', '**/*.ftl', '**/messages/*.json'],
    reason:
      'Translation resources changed. Check key parity across locales, placeholder and plural-form consistency, and any string left untranslated or hard-coded.',
  },
  {
    role: 'security-scanner',
    match: ['**/auth/**', '**/*credential*', '**/*secret*', '**/.env.example', '**/security/**'],
    reason:
      'Code on an authentication, credential, or secret-handling path changed. Look for leaked or logged secrets, weakened validation, and authorisation checks that moved or disappeared.',
  },
  {
    role: 'api',
    match: [
      '**/openapi*.yaml',
      '**/openapi*.yml',
      '**/openapi*.json',
      '**/*.proto',
      '**/*.graphql',
    ],
    reason:
      'An API contract changed. Check backward compatibility for clients already deployed against it, whether the change is additive or breaking, versioning, and whether error and pagination semantics still hold.',
  },
  {
    role: 'devops',
    match: [
      '**/Dockerfile',
      '**/Dockerfile.*',
      '**/docker-compose*.yaml',
      '**/docker-compose*.yml',
      '.github/workflows/**',
      '**/*.tf',
      '**/k8s/**',
      '**/helm/**',
    ],
    reason:
      'Build, container, or deployment configuration changed. Check reproducibility, whether the change is safe to roll out and roll back, secret handling in the pipeline, and image or job permissions.',
  },
  {
    role: 'e2e',
    match: ['**/e2e/**', '**/cypress/**', '**/playwright.config.*'],
    reason:
      'End-to-end test scaffolding changed. Check that the journeys still assert user-visible outcomes rather than implementation details, and that nothing added a source of flake — fixed waits, shared state between specs, order dependence.',
  },
  {
    role: 'performance',
    match: ['**/benchmarks/**', '**/*.bench.ts', '**/*.bench.js'],
    reason:
      'Benchmark code changed. Check that the measurement still isolates what it claims to, that the baseline is comparable to previous runs, and that the numbers would survive being quoted in a decision.',
  },
  {
    role: 'payments',
    match: ['**/payments/**', '**/billing/**', '**/*invoice*'],
    reason:
      'Payment or ledger code changed. Check idempotency of every externally-triggered path, refund and partial-refund handling, webhook replay, and whether balances can be left inconsistent by a failure mid-sequence.',
  },
  {
    role: 'ios',
    match: ['**/*.swift', '**/Podfile', '**/*.xcodeproj/**'],
    reason:
      'Apple-platform code changed. Check lifecycle and memory semantics, main-thread work, and whether the change holds on the SDK versions the project targets.',
  },
  {
    role: 'android',
    match: ['**/*.kt', '**/build.gradle', '**/build.gradle.kts', '**/AndroidManifest.xml'],
    reason:
      'Android code changed. Check lifecycle handling, configuration-change survival, permissions declared versus used, and whether the change holds on the API levels the project targets.',
  },
]);

export interface SpecialistTriggerConfig {
  enabled?: boolean | undefined;
  /** Replaces the shipped rules entirely when set. */
  rules?: SpecialistTriggerRule[] | undefined;
  /** Extra rules appended to whichever set is in force. */
  extraRules?: SpecialistTriggerRule[] | undefined;
  /** Quiet window before a settled path set fires. Default 20000. */
  debounceMs?: number | undefined;
  /** Most specialists in flight from this plugin at once. Default 2. */
  maxConcurrent?: number | undefined;
  /** Most triggers per session, across all rules. Default 8. */
  maxPerSession?: number | undefined;
}

export interface ResolvedSpecialistTriggerConfig {
  enabled: boolean;
  rules: SpecialistTriggerRule[];
  debounceMs: number;
  maxConcurrent: number;
  maxPerSession: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** A rule missing either half of `role`/`match` can only misfire. Drop it. */
function usableRules(rules: unknown): SpecialistTriggerRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (rule): rule is SpecialistTriggerRule =>
      !!rule &&
      typeof rule === 'object' &&
      typeof (rule as SpecialistTriggerRule).role === 'string' &&
      (rule as SpecialistTriggerRule).role.length > 0 &&
      Array.isArray((rule as SpecialistTriggerRule).match) &&
      (rule as SpecialistTriggerRule).match.length > 0,
  );
}

/**
 * Resolve user config over the shipped defaults.
 *
 * `enabled` defaults to FALSE and requires `=== true`. This plugin spawns
 * agents that cost money without anybody asking, and autonomy is the user's to
 * grant — a default that quietly starts spending would be the system handing
 * itself permission.
 */
export function resolveSpecialistTriggerConfig(
  raw: SpecialistTriggerConfig | undefined,
  _config?: Config | undefined,
): ResolvedSpecialistTriggerConfig {
  const cfg = raw ?? {};
  const base = cfg.rules !== undefined ? usableRules(cfg.rules) : [...DEFAULT_SPECIALIST_TRIGGERS];
  return {
    enabled: cfg.enabled === true,
    rules: [...base, ...usableRules(cfg.extraRules)],
    debounceMs: positiveInteger(cfg.debounceMs, 20_000),
    maxConcurrent: positiveInteger(cfg.maxConcurrent, 2),
    maxPerSession: positiveInteger(cfg.maxPerSession, 8),
  };
}

export interface SpecialistTriggerMatch {
  rule: SpecialistTriggerRule;
  /** Changed paths that matched, sorted so the fire key is stable. */
  paths: string[];
}

/** Normalise a repo-relative path so Windows separators still match globs. */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Match changed paths against the rules.
 *
 * A path may match several rules and wake each of them — a migration written in
 * `auth/` genuinely concerns both the database and the security agent, and
 * making them compete for it would just hide one of the two findings.
 */
export function matchSpecialistTriggers(
  changedPaths: string[],
  rules: readonly SpecialistTriggerRule[],
): SpecialistTriggerMatch[] {
  const posix = changedPaths.map(toPosixPath);
  const out: SpecialistTriggerMatch[] = [];
  for (const rule of rules) {
    const paths = posix.filter((candidate) => matchAny(rule.match, candidate)).sort();
    if (paths.length > 0) out.push({ rule, paths });
  }
  return out;
}

/**
 * Identity of one firing: role plus the exact path set. Re-fires only when the
 * set changes, so a file edited fifty times in a session wakes its specialist
 * once — the alternative is a spawn per keystroke-batch, which is how a helpful
 * background agent turns into a bill.
 */
export function specialistFireKey(match: SpecialistTriggerMatch): string {
  // JSON rather than a joined string: a path may legally contain the separator,
  // and `[a, 'b c']` colliding with `['a b', c]` would silence one of the two
  // firings for the rest of the session.
  return JSON.stringify([match.rule.role, ...match.paths]);
}

/** The task text handed to the woken specialist. */
export function specialistTaskText(match: SpecialistTriggerMatch): string {
  const list = match.paths.map((filePath) => `  - ${filePath}`).join('\n');
  return [
    match.rule.reason,
    '',
    'Changed files:',
    list,
    '',
    'You were woken by a file-pattern trigger, not by a person — nobody is blocked',
    'on you and nothing has been decided. Read the change first. If it raises',
    'nothing worth saying, say exactly that and stop: "no concerns" plus what you',
    'checked is a useful answer, and padding it out is not.',
    'Report findings with file and line references.',
  ].join('\n');
}
