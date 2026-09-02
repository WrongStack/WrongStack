import { tokenize } from '../store-helpers.js';
import type { MemoryAnchor, Sage } from '../types.js';

const GENERIC_QUERY_TERMS = new Set([
  'add',
  'after',
  'and',
  'are',
  'backfill',
  'bash',
  'before',
  'change',
  'code',
  'command',
  'context',
  'edit',
  'file',
  'files',
  'find',
  'fix',
  'for',
  'from',
  'glob',
  'grep',
  'imported',
  'inject',
  'injected',
  'injector',
  'legacy',
  'memory',
  'model',
  'node',
  'output',
  'package',
  'packages',
  'path',
  'project',
  'provider',
  'read',
  'recovered',
  'recovery',
  'remove',
  'result',
  'results',
  'restored',
  'run',
  'source',
  'src',
  'test',
  'tests',
  'that',
  'the',
  'this',
  'tool',
  'tree',
  'update',
  'using',
  'with',
  'write',
  'wrongstack',
]);

export interface MemoryQueryRelevance {
  strength: number;
  evidence: string[];
}

/**
 * Measure concrete query-to-memory evidence without allowing metadata quality
 * to manufacture relevance. Generic coding words are ignored, and a broad
 * multi-term task needs at least two textual matches unless an anchor or tag
 * provides a stronger relationship.
 */
export function memoryQueryRelevance(memory: Sage, query: string): MemoryQueryRelevance {
  const { normalizedQuery, queryTerms } = prepareQuery(query);
  if (queryTerms.length === 0) return { strength: 0, evidence: [] };

  for (const anchor of memory.anchors) {
    const exact = exactAnchorValue(anchor);
    if (exact && normalizedQuery.includes(exact)) {
      return {
        strength: anchor.type === 'symbol' || anchor.type === 'command' ? 0.98 : 0.96,
        evidence: [`query:exact-${anchor.type}`],
      };
    }
  }

  const textTerms = new Set(informativeTerms(memory.text));
  const tagTerms = new Set(memory.tags.flatMap(informativeTerms));
  // Symbols, commands and roles only — deliberately NOT anchor paths. A path
  // is matched as a path (verbatim in the query above, or by the tool-call
  // middleware against the file the tool actually touched); letting its
  // segments also feed fuzzy word matching double-counts the same anchor and
  // makes any memory about `<pkg>/src/store.ts` look like evidence for every
  // other `store.ts` in the repository.
  const anchorTerms = new Set(
    memory.anchors.flatMap((anchor) =>
      informativeTerms([anchor.symbol, anchor.command, anchor.role].filter(Boolean).join(' ')),
    ),
  );
  const allTerms = new Set([...textTerms, ...tagTerms, ...anchorTerms]);
  const matched = queryTerms.filter((term) => allTerms.has(term));
  if (matched.length === 0) return { strength: 0, evidence: [] };

  const anchorMatches = matched.filter((term) => anchorTerms.has(term));
  const tagMatches = matched.filter((term) => tagTerms.has(term));
  const evidence: string[] = [];
  if (anchorMatches.length > 0)
    evidence.push(`query:anchor-terms:${anchorMatches.slice(0, 3).join(',')}`);
  if (tagMatches.length > 0) evidence.push(`query:tag-terms:${tagMatches.slice(0, 3).join(',')}`);
  evidence.push(`query:text-terms:${matched.slice(0, 4).join(',')}`);

  // Evidence tiers, deliberately split around the tool-call middleware's
  // relation floor. What lifts a tier is not how many words coincided but how
  // much of the question they answered: three shared words out of a
  // three-word search is the memory the caller asked for, while the same
  // three out of a twelve-term enriched path query is a coincidence. One
  // isolated token — `store`, `session`, `middleware` — is why unrelated
  // memories used to arrive stapled to files they say nothing about.
  const answersTheQuery = matched.length / queryTerms.length >= 0.6 || matched.length >= 4;
  if (anchorMatches.length >= 2) {
    return { strength: Math.min(0.92, 0.78 + anchorMatches.length * 0.05), evidence };
  }
  if (anchorMatches.length === 1) {
    return { strength: answersTheQuery ? 0.82 : 0.72, evidence };
  }
  if (tagMatches.length >= 2) {
    return { strength: Math.min(0.88, 0.74 + tagMatches.length * 0.05), evidence };
  }
  if (tagMatches.length === 1) {
    return { strength: answersTheQuery ? 0.78 : 0.7, evidence };
  }
  if (matched.length >= 3) {
    return {
      strength: answersTheQuery ? Math.min(0.86, 0.76 + matched.length * 0.02) : 0.72,
      evidence,
    };
  }
  if (matched.length === 2) return { strength: answersTheQuery ? 0.72 : 0.68, evidence };
  // One shared word out of a one- or two-word query. Real evidence when a
  // person typed the query — half of what they asked about — but far too
  // little to staple a memory onto a tool result, so it sits deliberately
  // below the tool-call middleware's relation floor and can only ever reach
  // the (opt-in) turn-context path.
  if (queryTerms.length <= 2) return { strength: 0.66, evidence };
  return { strength: 0, evidence: [] };
}

/** Structural corroboration required before a graph-expanded memory is injected. */
export function memoryStructuralRelevance(memory: Sage, seeds: Sage[]): MemoryQueryRelevance {
  const memoryAnchors = structuralAnchorKeys(memory);
  const memoryTags = new Set(memory.tags.flatMap(informativeTerms));
  for (const seed of seeds) {
    const sharedAnchors = [...memoryAnchors].filter((key) => structuralAnchorKeys(seed).has(key));
    if (sharedAnchors.length > 0) {
      return { strength: 0.86, evidence: [`graph:shared-anchor:${sharedAnchors[0]}`] };
    }
    const seedTags = new Set(seed.tags.flatMap(informativeTerms));
    const sharedTags = [...memoryTags].filter((tag) => seedTags.has(tag));
    if (sharedTags.length >= 2) {
      return {
        strength: 0.72,
        evidence: [`graph:shared-tags:${sharedTags.slice(0, 3).join(',')}`],
      };
    }
  }
  return { strength: 0, evidence: [] };
}

interface PreparedQuery {
  normalizedQuery: string;
  queryTerms: string[];
}

/**
 * Normalize + tokenize the query, memoizing the last one.
 *
 * Both callers of `memoryQueryRelevance` score a whole candidate set against a
 * single query in one pass — turn-memory inside a `.filter()`, tool-call-memory
 * inside a `.map()` over an over-fetched pool of 64+ hits. The per-memory work
 * genuinely differs each call, but the query side does not: without this the
 * same string was NFKC-normalized, lowercased, regex-split and stop-word
 * filtered once per candidate. One slot is enough — the access pattern is a
 * tight loop over one query, not an interleaving of many.
 *
 * The returned `queryTerms` array is shared across calls, so it must stay
 * read-only; `memoryQueryRelevance` only reads and `.filter()`s it.
 */
let lastQueryKey: string | undefined;
let lastQueryValue: PreparedQuery | undefined;

function prepareQuery(query: string): PreparedQuery {
  if (lastQueryKey === query && lastQueryValue) return lastQueryValue;
  const prepared: PreparedQuery = {
    normalizedQuery: query.normalize('NFKC').toLowerCase().replace(/\\/g, '/'),
    queryTerms: informativeTerms(query),
  };
  lastQueryKey = query;
  lastQueryValue = prepared;
  return prepared;
}

function informativeTerms(text: string): string[] {
  return tokenize(text)
    .map((term) => term.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((term) => term.length >= 3 && !GENERIC_QUERY_TERMS.has(term));
}

function exactAnchorValue(anchor: MemoryAnchor): string | undefined {
  const value = anchor.symbol ?? anchor.command ?? anchor.path ?? anchor.role;
  if (!value) return undefined;
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '.' || normalized.length < 4) return undefined;
  return normalized;
}

function structuralAnchorKeys(memory: Sage): Set<string> {
  const keys = new Set<string>();
  for (const anchor of memory.anchors) {
    const value = exactAnchorValue(anchor);
    if (value) keys.add(`${anchor.type}:${value}`);
  }
  return keys;
}
