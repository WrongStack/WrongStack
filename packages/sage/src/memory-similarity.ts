/**
 * Pure memory-to-memory comparison: structural relationship ranking,
 * contradiction (opposite-polarity) detection and near-duplicate detection.
 * Re-exported from `store-helpers.ts`.
 */

import { tokenize } from './memory-text.js';
import { normalizeSlashes } from './paths.js';
import { DEFAULT_PERSISTENCE, type MemoryAnchor, type Sage, type SageKind } from './types.js';

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
        const leftPath = normalizeAnchorPath(left.path);
        const rightPath = normalizeAnchorPath(right.path);
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
          } else if (
            leftPath === '.' ||
            rightPath === '.' ||
            leftPath.startsWith(`${rightPath}/`) ||
            rightPath.startsWith(`${leftPath}/`)
          ) {
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
  const importance = Number.isFinite(candidate.importance) ? candidate.importance : 0;
  const confidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 0;
  const freshness = Number.isFinite(candidate.freshness) ? candidate.freshness : 0;
  return relation + importance * 2 + confidence + freshness + persistenceBonus + durableKindBonus;
}

function normalizeCommand(command: string): string {
  return command.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function commandFamily(command: string): string {
  return command.split(/\s+/).slice(0, 2).join(' ');
}

function normalizeAnchorPath(p: string | undefined): string {
  if (!p) return '';
  const trimmed = p.trim();
  if (!trimmed) return '';
  const normalized = normalizeSlashes(trimmed)
    .toLowerCase()
    .replace(/^\.\/+/, '');
  return normalized === '' ? '.' : normalized;
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

function foldNegationPhrases(text: string): string {
  return text.replace(/\bno\s+longer\b/gi, 'no_longer');
}

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
  // `tokenize` drops terms under 3 chars, so "no longer" would reach the cue
  // check as plain "longer" and the `no_longer` cue could never match.
  const tokensA = tokenize(foldNegationPhrases(a.text));
  const tokensB = tokenize(foldNegationPhrases(b.text));
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
  if (anchor.type === 'symbol' && anchor.symbol) {
    const sym = anchor.symbol.trim().toLowerCase();
    if (anchor.path) {
      const p = normalizeSlashes(anchor.path).toLowerCase();
      return `symbol:${p}#${sym}`;
    }
    return `symbol:${sym}`;
  }
  if (anchor.path) {
    const path = normalizeSlashes(anchor.path).toLowerCase();
    return `${anchor.type}:${path}`;
  }
  return undefined;
}
