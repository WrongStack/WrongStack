/**
 * Pure helper functions shared across store implementations.
 * These functions have no side effects and no dependency on the store instance.
 */

import type { MemoryScope } from '@wrongstack/core/types';
import { normalizeProjectPath, normalizeSlashes } from './paths.js';
import {
  DEFAULT_PERSISTENCE,
  legacyToSageScope,
  VALID_PERSISTENCE,
  type MemoryAnchor,
  type MemoryAudienceSelector,
  type RememberSageInput,
  type Sage,
  type SageKind,
  type SageScope,
} from './types.js';

const MAX_MEMORY_TEXT_CHARS = 20_000;
const MAX_MEMORY_METADATA_ITEMS = 128;

const VALID_SCOPES = new Set<SageScope>(['project', 'user', 'session', 'file', 'symbol']);
export const VALID_KINDS = new Set<SageKind>([
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
  'memory_review',
  'tool_outcome',
  'error_pattern',
  'session_digest',
  'role_operational',
  'task_outcome',
  'security_signal',
  'fleet_convention',
]);
const VALID_ANCHOR_TYPES = new Set<MemoryAnchor['type']>([
  'file',
  'directory',
  'symbol',
  'package',
  'command',
  'test',
  'git',
  'agent',
]);

const AUDIENCE_KEYS = ['roles', 'taskTypes', 'modes'] as const;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical tokenizer for retrieval scoring across BOTH the stores and the
 * injection middlewares — do not fork it. Invariants:
 * - NFKC + lowercase: strings differing only in unicode form/case tokenize alike.
 * - Unicode letters/numbers plus `_`, `.`, `-` are token characters, so
 *   identifiers like `edge-case`, `snake_case`, and `foo.bar` stay whole.
 * - Terms shorter than 3 characters are dropped: scoring does substring
 *   matching (`haystack.includes(term)`), where 1–2 char terms ("in", "go")
 *   match nearly every text and produce pure noise.
 * - Output is deduplicated; scoring operates on sets.
 */
export function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFKC')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .filter((term) => term.length >= 3),
    ),
  ];
}

/** Canonical text key for memory deduplication and comparison. */
export function normalizeTextKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Canonical dedup key for session consolidation and hygiene.
 * Strips trailing sentence-ending punctuation so "Use pnpm." and
 * "Use pnpm" produce the same key, while preserving internal
 * punctuation in identifiers (`C++`, `foo.bar`).
 */
export function canonicalMemoryText(text: string): string {
  return normalizeTextKey(text).replace(/[.!?,;:]+$/u, '');
}

export function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? []).map((tag) => tag.replace(/^#/, '').trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

export function normalizeAnchors(projectRoot: string, anchors: MemoryAnchor[]): MemoryAnchor[] {
  return dedupeAnchors(
    anchors.map((anchor) => ({
      ...anchor,
      path: anchor.path ? normalizeProjectPath(projectRoot, anchor.path) : undefined,
      symbol: anchor.symbol?.trim() || undefined,
      command: anchor.command?.trim().replace(/\s+/g, ' ') || undefined,
      role: anchor.role?.trim().toLowerCase() || undefined,
    })),
  );
}

export function normalizeAudience(
  value: MemoryAudienceSelector | undefined,
): MemoryAudienceSelector | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SAGE audience must be an object.');
  }
  const normalized: MemoryAudienceSelector = {};
  for (const key of AUDIENCE_KEYS) {
    const values = value[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) {
      throw new Error(`SAGE audience.${key} must be an array of strings.`);
    }
    if (values.length > MAX_MEMORY_METADATA_ITEMS) {
      throw new Error(`SAGE audience.${key} exceeds ${MAX_MEMORY_METADATA_ITEMS} items.`);
    }
    const items = [...new Set(values.map(normalizeSelectorValue).filter(Boolean))];
    if (items.some((item) => item.length > 256)) {
      throw new Error(`SAGE audience.${key} values must be no longer than 256 characters.`);
    }
    if (items.length > 0) normalized[key] = items;
  }
  return AUDIENCE_KEYS.some((key) => normalized[key]?.length) ? normalized : undefined;
}

export function normalizeSources(sources: Sage['sources']): Sage['sources'] {
  return dedupeSources(
    sources.map((source) => ({
      ...source,
      path: source.path ? normalizeSlashes(source.path.trim()) : undefined,
      command: source.command?.trim().replace(/\s+/g, ' ') || undefined,
    })),
  );
}

/** Rank explicit structural relationships shared with one or more seed memories. */
export function scoreMemoryRelationship(
  candidate: Sage,
  seeds: readonly Sage[],
  graphRelatedIds: ReadonlySet<string> = new Set(),
): number {
  if (seeds.some((seed) => seed.id === candidate.id)) return 0;
  let relation = graphRelatedIds.has(candidate.id) ? 8 : 0;

  for (const seed of seeds) {
    const sharedTags = candidate.tags.filter((tag) => seed.tags.includes(tag));
    relation += Math.min(4, sharedTags.length * 1.5);

    for (const left of candidate.anchors) {
      for (const right of seed.anchors) {
        const leftPath = left.path ? normalizeSlashes(left.path).toLowerCase() : '';
        const rightPath = right.path ? normalizeSlashes(right.path).toLowerCase() : '';
        if (
          left.symbol &&
          right.symbol &&
          left.symbol.toLowerCase() === right.symbol.toLowerCase()
        ) {
          relation += leftPath && leftPath === rightPath ? 12 : 8;
        }
        if (left.command && right.command) {
          const a = normalizeCommand(left.command);
          const b = normalizeCommand(right.command);
          if (a === b) relation += 10;
          else if (commandFamily(a) === commandFamily(b)) relation += 5;
        }
        if (left.role && right.role && left.role.toLowerCase() === right.role.toLowerCase()) {
          relation += 12;
        }
        if (leftPath && rightPath) {
          if (leftPath === rightPath) {
            relation += left.type === 'package' || right.type === 'package' ? 10 : 8;
          } else if (leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)) {
            relation += left.type === 'package' || right.type === 'package' ? 6 : 3;
          }
        }
      }
    }
  }

  if (relation <= 0) return 0;
  const persistence = candidate.persistence ?? DEFAULT_PERSISTENCE;
  const persistenceBonus = persistence === 'permanent' ? 2 : persistence === 'long_lived' ? 1 : -1;
  const durableKindBonus = [
    'fact',
    'decision',
    'convention',
    'warning',
    'anti_pattern',
    'workflow',
    'bug_root_cause',
    'file_note',
    'symbol_note',
    'command_note',
  ].includes(candidate.kind)
    ? 1
    : 0;
  return (
    relation +
    candidate.importance * 2 +
    candidate.confidence +
    candidate.freshness +
    persistenceBonus +
    durableKindBonus
  );
}

function normalizeCommand(command: string): string {
  return command.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function commandFamily(command: string): string {
  return command.split(/\s+/).slice(0, 2).join(' ');
}

/** Negation cues that flip the polarity of an otherwise-overlapping claim. */
const NEGATION_CUES = new Set([
  'not',
  'never',
  'none',
  'neither',
  'nor',
  'cannot',
  'cant',
  'no_longer',
  // Contraction stems — tokenize splits on the apostrophe, so "doesn't" ->
  // ["doesn", "t"] and the stem is the detectable cue. 'don'/'haven' collide
  // with standalone words ("don the hat", "safe haven") — the resulting false
  // POSITIVE is only a review-candidate (noise), while a false NEGATIVE would
  // let a don't/haven't claim MERGE into its positive at write time (data
  // loss), so the stems stay. Bare "can"/"won" are NOT cues ("the api can
  // cache" is positive; "won" can mean victory). Qualifier-style words
  // ("without", "unable") are deliberately excluded: "X without concurrent
  // writers" adds a constraint, it does not negate X.
  'don',
  'doesn',
  'isn',
  'aren',
  'wasn',
  'weren',
  'hasn',
  'haven',
  'didn',
  'couldn',
  'shouldn',
  'wouldn',
]);

/**
 * Deterministic v1 contradiction heuristic: both texts tokenize to ≥5 tokens,
 * their unique-token overlap is ≥0.72 (the near-dup structural threshold), and
 * exactly ONE member's exclusive tokens contain a negation cue (or a strict
 * superset whose extras are a hard negation, e.g. "is stable" vs "is NOT
 * stable"). Deliberately conservative — it only flags near-identical claims
 * with opposite polarity, never stylistic differences or ordinary factual
 * disagreements. Shared by the remember merge path (a polarity pair must NOT
 * collapse into one memory) and the hygiene contradiction pass.
 */
export function isPossiblyContradictory(a: { text: string }, b: { text: string }): boolean {
  const tokensA = tokenize(a.text);
  const tokensB = tokenize(b.text);
  if (tokensA.length < 5 || tokensB.length < 5) return false;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const overlap = [...setA].filter((token) => setB.has(token)).length;
  const min = Math.min(setA.size, setB.size);
  if (min === 0 || overlap / min < 0.72) return false;
  const diffA = [...setA].filter((token) => !setB.has(token));
  const diffB = [...setB].filter((token) => !setA.has(token));
  // A strict superset is usually an additive qualifier ("X" vs "X without
  // concurrent writers") — but when the extras are a hard negation it IS a
  // contradiction and must be flagged (and never merged).
  if (diffA.length === 0) return diffB.some((token) => NEGATION_CUES.has(token));
  if (diffB.length === 0) return diffA.some((token) => NEGATION_CUES.has(token));
  const aNegated = diffA.some((token) => NEGATION_CUES.has(token));
  const bNegated = diffB.some((token) => NEGATION_CUES.has(token));
  return aNegated !== bNegated;
}

/** Kinds that are meaningless without a concrete structural binding. */
const STRUCTURAL_KINDS: ReadonlySet<SageKind> = new Set([
  'file_note',
  'symbol_note',
  'command_note',
]);

/**
 * Soft quality assessment for remember writes. Hard rejects go through
 * `validateRememberInput`; this caps confidence/importance so low-signal
 * memories rank below anchored, durable ones during injection.
 */
interface RememberQualityAdjustment {
  /** Cap applied to confidence after caller defaults. */
  confidenceCap: number;
  /** Cap applied to importance after caller defaults. */
  importanceCap: number;
  /** Human-readable reasons for diagnostics / audit. */
  reasons: string[];
}

/**
 * Token-set overlap coefficient (Szymkiewicz–Simpson) for near-duplicate
 * detection. Shared by remember merge and hygiene so thresholds agree.
 */
function textTokenOverlap(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / Math.min(left.size, right.size);
}

/**
 * Near-duplicate threshold for remember-time merge. High enough that
 * "PostgreSQL pool settings" vs "PostgreSQL index optimization" stay
 * distinct (overlap on one term), while paraphrases of the same fact merge.
 */
const NEAR_DUP_OVERLAP_THRESHOLD = 0.88;
/** Require enough tokens so short unrelated notes do not collide. */
const NEAR_DUP_MIN_TOKENS = 5;

/** True when two memories should merge as near-duplicates. */
export function isNearDuplicateMemory(
  left: { text: string; kind: SageKind; anchors: MemoryAnchor[] },
  right: { text: string; kind: SageKind; anchors: MemoryAnchor[] },
): boolean {
  if (left.kind !== right.kind) return false;
  const leftTokens = tokenize(left.text);
  const rightTokens = tokenize(right.text);
  if (leftTokens.length < NEAR_DUP_MIN_TOKENS || rightTokens.length < NEAR_DUP_MIN_TOKENS) {
    return false;
  }
  const overlap = textTokenOverlap(left.text, right.text);
  if (overlap >= NEAR_DUP_OVERLAP_THRESHOLD) return true;
  // Shared structural anchor + strong partial overlap is enough: the same
  // file/symbol note written twice with slightly different wording.
  if (overlap >= 0.72 && shareStructuralAnchor(left.anchors, right.anchors)) return true;
  return false;
}

function shareStructuralAnchor(a: MemoryAnchor[], b: MemoryAnchor[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const keys = new Set(
    a
      .map((anchor) => structuralAnchorKey(anchor))
      .filter((key): key is string => key !== undefined),
  );
  return b.some((anchor) => {
    const key = structuralAnchorKey(anchor);
    return key !== undefined && keys.has(key);
  });
}

function structuralAnchorKey(anchor: MemoryAnchor): string | undefined {
  if (anchor.type === 'command' && anchor.command) {
    return `command:${anchor.command.normalize('NFKC').trim().toLowerCase()}`;
  }
  if (anchor.type === 'agent' && anchor.role) {
    return `agent:${anchor.role.toLowerCase()}`;
  }
  if (anchor.path) {
    const path = normalizeSlashes(anchor.path).toLowerCase();
    if (anchor.symbol) return `symbol:${path}#${anchor.symbol.toLowerCase()}`;
    return `${anchor.type}:${path}`;
  }
  return undefined;
}

/**
 * Ephemeral progress / session chatter that must not enter long-term store.
 * Intentionally narrow — "we decided to use X" is durable and must pass.
 */
const EPHEMERAL_REMEMBER_PATTERNS: readonly RegExp[] = [
  /^(wip|todo|fixme|hack)\b/i,
  /\b(still working on|looking into|need to (?:fix|check|investigate)|will (?:fix|look|check) (?:this|that|it) later)\b/i,
  /^(debugging|investigating|checking|reading) (the )?(file|code|issue|bug)\b/i,
  /^(fixed|updated|changed) (the )?(bug|issue|test|file)\.?$/i,
];

/**
 * Score a remember payload for injection quality. Returns caps rather than
 * rejecting so tests and short user preferences still persist; structural
 * kinds without anchors are hard-rejected in `validateRememberInput`.
 */
export function assessRememberQuality(input: {
  text: string;
  kind?: SageKind | undefined;
  anchors?: MemoryAnchor[] | undefined;
  tags?: string[] | undefined;
  scope?: SageScope | undefined;
}): RememberQualityAdjustment {
  const text = normalizeText(input.text);
  const tokens = tokenize(text);
  const anchors = input.anchors ?? [];
  const tags = input.tags ?? [];
  const reasons: string[] = [];
  let confidenceCap = 1;
  let importanceCap = 1;

  if (text.length < 12) {
    confidenceCap = Math.min(confidenceCap, 0.55);
    importanceCap = Math.min(importanceCap, 0.55);
    reasons.push('short_text');
  }
  if (tokens.length < 3) {
    confidenceCap = Math.min(confidenceCap, 0.6);
    importanceCap = Math.min(importanceCap, 0.6);
    reasons.push('few_tokens');
  }
  if (anchors.length === 0) {
    confidenceCap = Math.min(confidenceCap, 0.75);
    reasons.push('unanchored');
    // Durable project facts without anchors are hard to re-surface via path
    // inject — demote importance so anchored knowledge wins budget slots.
    if (input.scope !== 'session' && input.scope !== 'user') {
      importanceCap = Math.min(importanceCap, 0.7);
    }
  }
  if (tags.length === 0) {
    reasons.push('untagged');
  }
  if (input.kind === 'bug_root_cause' && anchors.length === 0) {
    confidenceCap = Math.min(confidenceCap, 0.65);
    importanceCap = Math.min(importanceCap, 0.75);
    reasons.push('root_cause_unanchored');
  }
  if (EPHEMERAL_REMEMBER_PATTERNS.some((pattern) => pattern.test(text))) {
    confidenceCap = Math.min(confidenceCap, 0.35);
    importanceCap = Math.min(importanceCap, 0.35);
    reasons.push('ephemeral_pattern');
  }

  return { confidenceCap, importanceCap, reasons };
}

export function validateRememberInput(input: RememberSageInput): void {
  if (typeof input.text !== 'string') throw new Error('SAGE text must be a string.');
  if (input.text.length > MAX_MEMORY_TEXT_CHARS) {
    throw new Error(`SAGE text exceeds ${MAX_MEMORY_TEXT_CHARS} characters.`);
  }
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) throw new Error('SAGE text must not be empty.');
  if (normalizedText.length < 4) {
    throw new Error('SAGE text is too short to be useful long-term memory.');
  }
  // Session-scoped memories MUST carry an owning session ID so retrieval and
  // injection can filter by session. Without this, a session-A memory would
  // leak into session-B search results and automatic injection.
  if (input.scope === 'session' && !input.ownerSessionId) {
    throw new Error(
      "SAGE scope 'session' requires ownerSessionId so the memory can be isolated to its owning session.",
    );
  }
  for (const [name, values] of [
    ['tags', input.tags],
    ['anchors', input.anchors],
    ['sources', input.sources],
    ['supersedes', input.supersedes],
    ['contradicts', input.contradicts],
  ] as const) {
    if (values && values.length > MAX_MEMORY_METADATA_ITEMS) {
      throw new Error(`SAGE ${name} exceeds ${MAX_MEMORY_METADATA_ITEMS} items.`);
    }
  }
  if (input.tags?.some((tag) => typeof tag !== 'string' || tag.length > 256)) {
    throw new Error('SAGE tags must be strings no longer than 256 characters.');
  }
  if (input.scope && !VALID_SCOPES.has(input.scope)) throw new Error('Invalid SAGE scope.');
  if (input.kind && !VALID_KINDS.has(input.kind)) throw new Error('Invalid SAGE kind.');
  // Runtime enforcement of the persistence class (the types.ts doc promises
  // this; unknown values previously slipped through and silently behaved as
  // non-permanent everywhere). UpdateSageInput goes through the same check in
  // sqlite-store-update.ts.
  if (input.persistence !== undefined && !VALID_PERSISTENCE.has(input.persistence)) {
    throw new Error(
      `Invalid SAGE persistence: expected one of ${[...VALID_PERSISTENCE].join(', ')}, got "${input.persistence}".`,
    );
  }
  if (
    input.kind &&
    STRUCTURAL_KINDS.has(input.kind) &&
    !(input.anchors && input.anchors.length > 0)
  ) {
    throw new Error(
      `SAGE kind "${input.kind}" requires at least one anchor (file/symbol/command binding).`,
    );
  }
  // Hard-reject pure progress chatter for non-session scopes. Session scope
  // is allowed to hold short-lived notes that expire.
  if (
    (input.scope ?? 'project') !== 'session' &&
    EPHEMERAL_REMEMBER_PATTERNS.some((pattern) => pattern.test(normalizedText))
  ) {
    throw new Error(
      'SAGE rejected ephemeral progress text. Store durable facts, decisions, conventions, or root causes — not WIP/todo chatter. Use todos for task state.',
    );
  }
  normalizeAudience(input.audience);
  for (const anchor of input.anchors ?? []) {
    if (!anchor || !VALID_ANCHOR_TYPES.has(anchor.type))
      throw new Error('Invalid SAGE anchor type.');
    if (anchor.type === 'command') {
      if (!anchor.command?.trim()) throw new Error('Command memory anchors require a command.');
    } else if (anchor.type === 'agent') {
      if (!anchor.role?.trim()) throw new Error('Agent memory anchors require a role.');
      if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(anchor.role.trim())) {
        throw new Error('Agent memory anchor role is invalid.');
      }
    } else if (!anchor.path?.trim()) {
      throw new Error(`${anchor.type} memory anchors require a path.`);
    }
    if (anchor.type === 'symbol' && !anchor.symbol?.trim()) {
      throw new Error('Symbol memory anchors require a symbol.');
    }
    // Per-type caps: paths can be deep absolute paths (Windows `C:\...`,
    // node_modules chains), commands can be long shell one-liners. A flat 256
    // rejects legitimate input — the stored form is relativized/short anyway.
    if (
      (anchor.path?.length ?? 0) > 4_096 ||
      (anchor.symbol?.length ?? 0) > 1_024 ||
      (anchor.command?.length ?? 0) > 8_192
    ) {
      throw new Error(
        'SAGE anchor strings are too long (path ≤ 4096, symbol ≤ 1024, command ≤ 8192, role ≤ 96 characters).',
      );
    }
  }
  for (const source of input.sources ?? []) {
    if (
      !source ||
      ![
        'user',
        'session',
        'tool_result',
        'project_instruction',
        'file',
        'test',
        'command',
        'legacy_memory',
      ].includes(source.type)
    ) {
      throw new Error('Invalid SAGE source type.');
    }
  }
}

// ─── Private dedup helpers ──────────────────────────────────────────────

function dedupeAnchors(anchors: MemoryAnchor[]): MemoryAnchor[] {
  return dedupeByKey(anchors, (anchor) =>
    JSON.stringify([
      anchor.type,
      anchor.path ?? null,
      anchor.symbol ?? null,
      anchor.command ?? null,
      anchor.role ?? null,
      anchor.contentHash ?? null,
      anchor.gitBlobHash ?? null,
      anchor.lineStart ?? null,
      anchor.lineEnd ?? null,
    ]),
  );
}

function dedupeSources(sources: Sage['sources']): Sage['sources'] {
  return dedupeByKey(sources, (source) =>
    JSON.stringify([
      source.type,
      source.sessionId ?? null,
      source.toolUseId ?? null,
      source.path ?? null,
      source.command ?? null,
      source.excerptHash ?? null,
    ]),
  );
}

function dedupeByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSelectorValue(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

// ─── Secret-detection guard (shared by JSONL and SQLite stores) ─────

/**
 * Check whether `text` looks like a secret or credential.
 * Used by both legacy and current store implementations to reject
 * unsafe candidate proposals before they reach the ReviewQueue.
 */
// Single anchored alternation covering every provider. Replaces the
// previous 11-regex array (which ran in O(11) per text node via
// .some(pattern => pattern.test(text))) with one engine pass. Each
// alternative is the full body of the original pattern verbatim —
// boundaries, character classes, and quantifiers are preserved
// exactly, so the synthetic-token fixtures in store-helpers.test.ts
// continue to match without modification. Unified flag is /i to
// preserve the generic env-style key=value match
// (api|secret|token|password, any case); the trade-off is that
// AWS AKIA matches case-insensitively (akia... would also match),
// but no real akia-prefixed token exists, so the false-positive
// cost is nil.
//
// Compiled once at module load rather than per call: `looksLikeSecret` runs
// against every nested string of a candidate (collectStringValues walks text,
// tags, anchors, sources), so rebuilding a ten-alternative pattern inside the
// function body paid the regex compiler on every string. No /g or /y flag, so
// the shared instance carries no lastIndex state between calls.
const SECRET_PATTERN = new RegExp(
  [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '\\b(?:api[_-]?key|secret|token|password)\\b\\s*[:=]\\s*[\'"]?[A-Za-z0-9_\\-./+=]{16,}',
    '\\b[A-Za-z0-9_]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\b',
    '\\b(?:sk-(?:ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\\b',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}\\b',
    '\\bhf_[A-Za-z0-9]{20,}\\b',
    '\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\\b',
    '\\bnpm_[A-Za-z0-9]{36,}\\b',
    '\\b[MNO][A-Za-z\\d]{23,}\\.[A-Za-z\\d_-]{6,}\\.[A-Za-z\\d_-]{27,}\\b',
  ].join('|'),
  'i',
);

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERN.test(text);
}

/**
 * Recursively collect every string value from a nested object/array.
 * Walks arrays and object values so every user-supplied field (text,
 * tags, anchors, sources, etc.) can be checked for unsafe content.
 */
export function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>))
      collectStringValues(item, out);
  }
  return out;
}

/**
 * Clamp a number into the [0, 1] range. Non-finite inputs collapse to 0,
 * which is the safe default for score-like values (a missing or NaN
 * score should not auto-accept or auto-reject in any non-trivial way).
 *
 * Shared across `SqliteSageStore`, the
 * memory-graph helpers, and `shared/session-consolidation` so every
 * score normalisation agrees on the same edge-case behaviour.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build a `(scope = ? OR legacy_scope = ?)` SQL fragment for legacy scope
 * filters. The two columns exist on the `memories` table so the predicate
 * matches both modern Sage-scope rows (`scope` column) and legacy-import
 * rows (`legacy_scope` column) without a JSON parse.
 *
 * Returns the **bare** predicate (no leading `AND`); callers prefix it
 * themselves to splice into their WHERE clause. This keeps the helper
 * independent of the surrounding condition (`status != 'deleted'`,
 * `status IN ('active','stale')`, etc.) that each callsite owns.
 *
 * Always emits the same two bind parameters so the helper is a true
 * source of truth for the dual-column filter — eliminate the four
 * near-identical copies that today each redeclare the same fragment.
 *
 * Replaces: `sqlite-store-legacy-clear.ts`, `sqlite-store-legacy-list.ts`,
 * `sqlite-store-legacy-forget.ts`, `sqlite-store-legacy-consolidate.ts`.
 */
export function legacyScopeFilterClause(scope: MemoryScope): {
  clause: string;
  params: [SageScope, MemoryScope];
} {
  return {
    clause: '(scope = ? OR legacy_scope = ?)',
    params: [legacyToSageScope(scope), scope],
  };
}
