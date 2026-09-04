import type { Middleware } from '@wrongstack/core/kernel';
import type { Message, Request, TextBlock } from '@wrongstack/core/types';
import { formatMemoryEvidenceBlock } from '@wrongstack/core/utils';
import { formatMemoryHintsDetailed } from '../retrieval/format.js';
import { memoryQueryRelevance, memorySemanticRelevance } from '../retrieval/relevance.js';
import { normalizeTextKey, tokenize } from '../store-helpers.js';
import { InjectionTracker } from './injection-tracker.js';
import type { SageSearchLike } from './tool-call-memory.js';

// Compatibility re-export; normalization authority lives in store-helpers.
export { normalizeTextKey, tokenize };

export interface SageTurnMiddlewareOptions {
  memory: SageSearchLike;
  maxMemories?: number | undefined;
  maxChars?: number | undefined;
  minScore?: number | undefined;
  /**
   * Weight given to the metadata score floor (0–1).
   * The final score is `metadataScore * (metadataWeight + relevance * (1 - metadataWeight))`.
   * At 0.0, relevance fully gates injection. At 1.0, metadata alone decides (pre-relevance behavior).
   * Default: 0.3 — validated against 148 real query-memory pairs (see commit history).
   */
  metadataWeight?: number | undefined;
  /**
   * Registry of recently injected memories used to detect assistant
   * references and credit `recordUse`. Pass the same instance to the
   * tool-call middleware so tool-result injections are matchable too.
   * Defaults to a private tracker (turn-context injections only).
   */
  tracker?: InjectionTracker | undefined;
  getSessionId?: (() => string | undefined) | undefined;
}

export function createSageTurnMiddleware(opts: SageTurnMiddlewareOptions): Middleware<Request> {
  const tracker = opts.tracker ?? new InjectionTracker();
  // Per-instance cached system-prompt normalizer. The factory owns its
  // closure-local cache state, which preserves test isolation and prevents
  // cross-session contamination when multiple middleware instances share
  // the same module.
  const getNormalizedSystem = makeNormalizedSystemFn();
  return {
    name: 'sage.turn-context',
    owner: 'sage',
    async handler(request, next) {
      let nextRequest = request;
      try {
        // Close the feedback loop first: if the previous assistant step
        // referenced a memory we injected earlier, credit the use before
        // registering this turn's injections.
        const assistantText = lastAssistantText(request.messages);
        if (assistantText) {
          const used = tracker.consumeMatches(assistantText, Date.now(), opts.getSessionId?.());
          if (used.length > 0) await opts.memory.recordUse?.(used, 'assistant_reference');
        }
        const query = lastUserText(request.messages);
        if (query) {
          const searchOptions = {
            limit: opts.maxMemories ?? 8,
            includeAudienceScoped: false,
            sessionId: opts.getSessionId?.(),
          };
          // Prefer the per-channel breakdown when the port can produce it.
          // The flat `searchSage` shape discards `vectorScore`, and this
          // middleware gates on `memoryQueryRelevance` — which is 0 for a hit
          // the vector channel found and the lexical channel missed. Without
          // the breakdown, every semantic-only recall is silently dropped one
          // line below the search that produced it.
          const hits = opts.memory.searchSageWithBreakdown
            ? await opts.memory.searchSageWithBreakdown(query, searchOptions)
            : (await opts.memory.searchSage(query, searchOptions)).map((memory) => ({
                memory,
                vectorScore: null as number | null,
              }));
          const vectorScoreById = new Map(
            hits.map((hit) => [hit.memory.id, hit.vectorScore ?? null]),
          );
          const memories = hits.map((hit) => hit.memory);
          const minScore = opts.minScore ?? 0.65;
          const metadataWeight = opts.metadataWeight ?? 0.3;
          // Cache the normalized system prompt by a content hash. The system
          // array is recreated every turn but its text content rarely changes,
          // so caching by an FNV-1a hash of the joined block text (O(system
          // length), ~1 in 4B collision for distinct prompts) lets us skip the
          // NFKC + regex re-normalization of a potentially 20KB+ prompt on
          // every turn. **The cache hits on the *join* cost** (the
          // `map(normalizeTextKey).join('\n')` work in `makeNormalizedSystemFn`);
          // the per-memory exclusion check (`existingSystem.includes(textKey)`)
          // at L100 is an O(N) substring scan that this cache does NOT speed
          // up — it is the unavoidable per-evaluation cost against the
          // normalized string. The middleware builds `nextRequest` as a
          // separate object (never mutating the input `request`), so the
          // fingerprint computed from `request.system` stays stable across
          // turns in the common runtime path — i.e. this cache hits on turn
          // N≥2 when the system prompt is unchanged. Cache state lives in the
          // closure below — see the `let lastSystemFingerprint` /
          // `let lastNormalizedSystem` pair inside `makeNormalizedSystemFn`
          // — to preserve test isolation and prevent cross-session
          // contamination.
          //
          // Latent-failure note: the dedup is an *exclusion* check
          // (`existingSystem.includes(textKey)`), so the failure mode is the
          // *inverse* of a normal cache — a stale hit does NOT cause a
          // duplicate injection, it silently *suppresses* a legitimate new
          // injection in a later turn (silent recall regression). The
          // composite fingerprint (length|textBlockCount|shape|contentHashes|
          // runningFnv) is engineered to catch reorder + same-length swap +
          // multi-block combinations; see `makeNormalizedSystemFn` below for
          // the full signal composition. Treat any change to that formula as
          // a recall-correctness change.
          const existingSystem = getNormalizedSystem(request.system);
          const seenText = new Set<string>();
          const eligible = memories.filter((memory) => {
            // Treat the retriever as an untrusted boundary: even an alternate
            // backend or test double must not put lifecycle history into the
            // ordinary system prompt.
            if (memory.status !== 'active' || memory.contextPolicy === 'never') return false;
            const textKey = normalizeTextKey(memory.text);
            if (seenText.has(textKey) || existingSystem.includes(textKey)) return false;
            const metadataScore =
              (memory.importance * 3 + memory.confidence * 2 + memory.freshness) / 6;
            // Same max-of-both-channels rule the tool-result path uses, so a
            // paraphrase recalled semantically is judged on its cosine rather
            // than on shared surface tokens it does not have.
            const relevance = Math.max(
              memoryQueryRelevance(memory, query).strength,
              memorySemanticRelevance(vectorScoreById.get(memory.id)).strength,
            );
            // Proven usefulness and anchors should win turn-context budget the
            // same way tool-result injection does — otherwise never-used noise
            // with default scores can crowd out anchored, previously-used facts.
            const uses = memory.useCount ?? 0;
            const useBoost = uses > 0 ? Math.min(0.1, 0.04 + uses * 0.015) : 0;
            const anchorBoost = memory.anchors.length > 0 ? 0.03 : -0.04;
            const injections = memory.injectionCount ?? 0;
            const unusedPenalty =
              injections >= 3 && uses === 0 ? Math.min(0.12, 0.03 + injections * 0.01) : 0;
            const score = Math.min(
              1,
              Math.max(
                0,
                metadataScore * (metadataWeight + relevance * (1 - metadataWeight)) +
                  useBoost +
                  anchorBoost -
                  unusedPenalty,
              ),
            );
            const accepted = relevance >= 0.62 && score >= minScore;
            if (accepted) seenText.add(textKey);
            return accepted;
          });
          const rendered = formatMemoryHintsDetailed(eligible, {
            maxChars: opts.maxChars ?? 2_400,
          });
          if (rendered.text) {
            await opts.memory.recordInjection?.(rendered.memoryIds, 'turn_context');
            const renderedIds = new Set(rendered.memoryIds);
            for (const memory of eligible) {
              if (renderedIds.has(memory.id)) {
                tracker.record(
                  memory.id,
                  memory.text,
                  Date.now(),
                  opts.getSessionId?.(),
                  rendered.text,
                );
              }
            }
            nextRequest = {
              ...request,
              system: [
                ...(request.system ?? []),
                {
                  type: 'text',
                  // Shared fence builder: `rendered.text` is memory bodies
                  // verbatim, so the closing delimiter has to be neutralized
                  // there or the block ends wherever a memory says it does.
                  text: formatMemoryEvidenceBlock('sage.turn-memory', rendered.text),
                  cache_control: { type: 'ephemeral' },
                },
              ],
            };
          }
        }
      } catch {
        nextRequest = request;
      }
      return next(nextRequest);
    },
  };
}

function lastUserText(messages: Message[]): string {
  return lastMessageTextByRole(messages, 'user');
}

function lastAssistantText(messages: Message[]): string {
  return lastMessageTextByRole(messages, 'assistant');
}

function lastMessageTextByRole(messages: Message[], role: Message['role']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== role) continue;
    const text =
      typeof message.content === 'string'
        ? message.content.trim()
        : Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join(' ')
              .trim()
          : '';
    if (text) return text;
  }
  return '';
}

/**
 * Compute the overlap coefficient (Szymkiewicz–Simpson) between two strings
 * based on their token sets. Returns 0..1 where 1 means every token in the
 * shorter string also appears in the longer one.
 *
 * Unlike Jaccard, this doesn't penalize the longer string for having extra
 * tokens — a memory with rich detail that fully covers the query scores high.
 */
export function overlapCoefficient(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  const textTokens = new Set(tokenize(text));
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) intersection++;
  }
  const smaller = Math.min(queryTokens.size, textTokens.size);
  return intersection / smaller;
}

/**
 * Build a per-instance cached system-prompt normalizer. We use the canonical
 * `TextBlock` type from `@wrongstack/core` (which has `type: 'text'` literal,
 * required `text: string`, and an optional `cache_control?` field for
 * Anthropic prompt caching). A `ReadonlyArray<TextBlock> | undefined` input
 * accepts `request.system: TextBlock[] | undefined` without conversion, and
 * the `if (block.type !== 'text' || !block.text) continue` guard below
 * excludes tool/image blocks from the fingerprint and the normalized string.
 */
function makeNormalizedSystemFn(): (system: ReadonlyArray<TextBlock> | undefined) => string {
  // Cache key composes five independent signals:
  //   (1) system.length — the *only* signal that catches non-text blocks
  //       added/removed (tool_use, image, future Anthropic block kinds); the
  //       remaining signals deliberately scope to text blocks because they
  //       describe text-block content, so a non-text block can only change
  //       the fingerprint via this `system.length` signal.
  //   (2) text-block count — catches text-block count changes.
  //   (3) per-text-block raw-length sequence — catches reorder at the same
  //       total length.
  //   (4) per-text-block content FNV-1a hash sequence — catches two text
  //       blocks of the same length with different content (e.g. swapped
  //       same-length paragraphs, NFKC re-encodings that change byte length
  //       but not display width).
  //   (5) running FNV-1a over all text-block content — final guard against
  //       multi-block combinations whose per-block hashes coincidentally
  //       permute to the same concatenated sequence.
  // The dedup is an *exclusion* check (`existingSystem.includes(textKey)`),
  // so a stale hit silently suppresses a legitimate new injection — every
  // collision-resistance signal above must remain present. Treat any change
  // to the fingerprint formula as a recall-correctness change, not a perf
  // change.
  //
  // Cross-axis invariant: the fingerprint is computed from raw block text,
  // but `lastNormalizedSystem` is computed from `normalizeTextKey`-reduced
  // text. If `normalizeTextKey` ever changes (e.g. a new unicode form, an
  // NFKC→NFC switch, a stricter trim), the raw-text fingerprint stays
  // stable while the normalized string changes shape, and the cached
  // `includes()` check silently returns stale results — permanent silent
  // recall suppression until the middleware is recreated.
  //
  // Mitigation: the version prefix below is mixed into every fingerprint.
  // Bump `NORMALIZER_VERSION` any time `normalizeTextKey`'s output shape
  // can change (unicode form switch, trim rule change, whitespace-collapse
  // rule change). The cache miss on version bump costs one re-normalize of
  // the full system prompt — bounded and one-time.
  //
  // Base-prompt invariant: this middleware *appends* a rendered-memory-hint
  // block to `request.system` on every successful injection (see handler
  // at L126-129). On turn N≥2 the input `request.system` therefore contains
  // N−1 prior appended blocks, and keying the fingerprint on the full
  // `system.length` would make the cache miss on every turn — the FNV-1a
  // hashing cost would be paid every turn instead of amortized.
  //
  // The cache contract is therefore: **the cache hits on turn N≥2 iff the
  // full `request.system` (including all prior appended memory-hint blocks)
  // is unchanged.** Because this middleware itself appends a block on every
  // successful injection, the steady-state cache will miss on every turn
  // N≥2 that produced an injection — the fingerprint amortizes only across
  // turns where no memory hint was appended (no eligible memory, or all
  // candidates filtered out). The FNV work over the appended blocks is
  // bounded (one block per turn, ~few KB), so the cost is negligible.
  //
  // An earlier version of this code locked the base length on the first turn
  // and capped the fingerprint at `baseSystemLength` so the cache could hit
  // on turn N≥2 even after appended blocks. That optimization was dropped
  // because it silently failed the cache invariant when the *base* system
  // prompt shrank (a contributor removed a block on turn N≥2): the
  // fingerprint stayed pinned to the larger original base length, so the
  // loop walked past `system.length` and the fingerprint never reflected
  // the real shrink — the cache hit when it should miss, suppressing
  // legitimate new injections against the now-truncated content. The current
  // contract has no such blind spot.
  const NORMALIZER_VERSION = 'v1';
  let lastSystemFingerprint = '';
  let lastNormalizedSystem = '';
  return function normalizedSystem(system: ReadonlyArray<TextBlock> | undefined): string {
    if (!system || system.length === 0) return '';
    let textBlocks = 0;
    let shape = '';
    let contentHashes = '';
    let hash = 0x811c9dc5;
    for (let i = 0; i < system.length; i++) {
      const block = system[i];
      if (block?.type !== 'text' || !block.text) continue;
      const text = block.text;
      textBlocks++;
      shape += `${text.length},`;
      // Per-block content hash — independent of the global hash below so
      // that a coincidental swap of two same-length blocks changes the
      // content-hash sequence and invalidates the cache.
      let blockHash = 0x811c9dc5;
      for (let j = 0; j < text.length; j++) {
        blockHash ^= text.charCodeAt(j);
        blockHash = Math.imul(blockHash, 0x01000193);
      }
      contentHashes += `${blockHash >>> 0},`;
      // Running global hash catches combinations whose per-block hashes
      // happen to permute to the same sequence.
      for (let j = 0; j < text.length; j++) {
        hash ^= text.charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
      // Separator hash so adjacent blocks don't merge.
      hash ^= 0x0a;
      hash = Math.imul(hash, 0x01000193);
    }
    const fingerprint = `${NORMALIZER_VERSION}|${system.length}|${textBlocks}|${shape}|${contentHashes}|${hash >>> 0}`;
    if (fingerprint === lastSystemFingerprint) return lastNormalizedSystem;
    lastSystemFingerprint = fingerprint;
    // Mirror the fingerprint filter at L277-281: skip non-text and
    // empty-text blocks so the normalized string stays in lockstep with
    // `textBlocks`/`shape`/`contentHashes`. Without this filter the cache
    // hit returns the same fingerprint as a different normalized string
    // (e.g. `[textA, emptyTextBlock, textB]` → fingerprint counts 2 text
    // blocks but the join produces `"A\n\nB"`), breaking the
    // `existingSystem.includes(textKey)` dedup invariant for the same
    // fingerprint on cache hit vs miss.
    lastNormalizedSystem = system
      .filter((block) => block?.type === 'text' && block.text)
      .map((block) => normalizeTextKey(block.text))
      .join('\n');
    return lastNormalizedSystem;
  };
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const turnMemoryCoverage = {
  makeNormalizedSystemFn,
  lastMessageTextByRole,
};
