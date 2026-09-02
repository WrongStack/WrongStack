import { normalizeTextKey, tokenize } from '../store-helpers.js';

export interface InjectionTrackerOptions {
  /** How long an injection stays matchable. Default: 2 hours. */
  ttlMs?: number | undefined;
  /** Maximum tracked injections; oldest are evicted beyond this. Default: 500. */
  maxEntries?: number | undefined;
  /**
   * Minimum distinct tokens a memory text needs to be trackable. Shorter
   * memories match ordinary prose too easily to be a trustworthy signal.
   * Default: 4.
   */
  minTokens?: number | undefined;
  /**
   * Overlap coefficient (memory tokens ∩ assistant tokens / smaller set)
   * required to count a reference as a use. Default: 0.5.
   */
  matchThreshold?: number | undefined;
  /**
   * Absolute minimum shared tokens for a ratio-based match. Without this,
   * a 4-token memory only needs 2 coincidental overlaps at the default
   * threshold and falsely credits `recordUse`. Id citations and long
   * phrase containment bypass this floor. Default: 3.
   */
  minMatchTokens?: number | undefined;
}

interface TrackedInjection {
  textKey: string;
  tokens: number;
  /** Cached token set — built once at record() time so consumeMatches()
   *  never re-tokenizes the memory text on every assistant turn. */
  tokenSet: Set<string>;
  at: number;
}

interface ContextInjection {
  memoryId: string;
  contextTextKey: string;
  at: number;
  sessionId?: string | undefined;
}

export interface ContextMemorySnapshot {
  activeMemoryIds: string[];
  enteredMemoryIds: string[];
  exitedMemoryIds: string[];
}

/**
 * Process-local registry of memories recently injected into context, used to
 * close the usefulness feedback loop: when a later assistant message references
 * an injected memory, the store's `recordUse` counter is credited.
 *
 * Deliberately NOT session-keyed: the turn middleware has no session id on the
 * request object, and a cross-session attribution error only shifts an
 * approximate counter between sessions of the same project. Consume-once
 * semantics (each injection yields at most one use) bound the error.
 */
export class InjectionTracker {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly minTokens: number;
  private readonly matchThreshold: number;
  private readonly minMatchTokens: number;
  private readonly entries = new Map<string, TrackedInjection>();
  private readonly contextEntries = new Map<string, ContextInjection>();
  private readonly activeContextBySession = new Map<
    string,
    { memoryIds: Set<string>; at: number }
  >();
  /** Throttle prune() to at most once per interval — the TTL is 2 hours,
   *  so pruning on every single operation is pure waste. */
  private lastPruneAt = 0;
  private static readonly PRUNE_INTERVAL_MS = 30_000;

  constructor(opts: InjectionTrackerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 2 * 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.minTokens = opts.minTokens ?? 4;
    this.matchThreshold = opts.matchThreshold ?? 0.5;
    this.minMatchTokens = opts.minMatchTokens ?? 3;
  }

  /** Register an injected memory as matchable. Text is normalized once here. */
  record(
    memoryId: string,
    text: string,
    now = Date.now(),
    sessionId?: string,
    renderedContextText?: string,
  ): void {
    const textKey = normalizeTextKey(text);
    const tokenSet = new Set(tokenize(textKey));
    const tokens = tokenSet.size;
    if (tokens < this.minTokens) return;
    this.prune(now);
    this.entries.set(memoryId, { textKey, tokens, tokenSet, at: now });
    const contextKey = `${sessionId ?? '<no-session>'}\0${memoryId}`;
    this.contextEntries.set(contextKey, {
      memoryId,
      contextTextKey: contextNeedle(textKey, renderedContextText, this.minTokens),
      at: now,
      sessionId,
    });
  }

  /**
   * Compare tracked injections with the exact provider-bound request text.
   * This is the authoritative boundary for "in context" vs "left context":
   * compaction, clear, and session rewrites naturally disappear on the next
   * request without guessing from token counts.
   */
  snapshotContext(
    requestText: string,
    sessionId?: string,
    now = Date.now(),
  ): ContextMemorySnapshot {
    return this.snapshotContextParts([requestText], sessionId, now);
  }

  /**
   * Snapshot provider-visible context without first concatenating the entire
   * request into one large temporary string.
   */
  snapshotContextParts(
    requestParts: Iterable<string>,
    sessionId?: string,
    now = Date.now(),
  ): ContextMemorySnapshot {
    this.prune(now);
    const sessionKey = sessionId ?? '<no-session>';
    const normalizedParts = [...requestParts]
      .map((part) => normalizeTextKey(part))
      .filter((part) => part.length > 0);
    const active = new Set<string>();
    for (const entry of this.contextEntries.values()) {
      if ((entry.sessionId ?? '<no-session>') !== sessionKey) continue;
      if (normalizedParts.some((part) => part.includes(entry.contextTextKey))) {
        active.add(entry.memoryId);
      }
    }
    const previous = this.activeContextBySession.get(sessionKey)?.memoryIds ?? new Set<string>();
    const enteredMemoryIds = [...active].filter((id) => !previous.has(id));
    const exitedMemoryIds = [...previous].filter((id) => !active.has(id));
    this.activeContextBySession.set(sessionKey, { memoryIds: active, at: now });
    while (this.activeContextBySession.size > this.maxEntries) {
      const oldest = this.activeContextBySession.keys().next().value as string;
      this.activeContextBySession.delete(oldest);
    }
    return {
      activeMemoryIds: [...active],
      enteredMemoryIds,
      exitedMemoryIds,
    };
  }

  /**
   * Return the memory ids whose registered text is referenced by
   * `assistantText`, consuming them so each injection counts at most one use.
   *
   * The assistant text is tokenized once; each entry's token set was cached
   * at record() time, so this loop is O(entries × |tokenSet|) set lookups
   * instead of O(entries × tokenize_cost) re-normalizations.
   *
   * When `sessionId` is provided, only entries recorded for that session
   * are eligible for matching — preventing cross-session use attribution
   * when a shared tracker serves concurrent sessions.
   */
  consumeMatches(assistantText: string, now = Date.now(), sessionId?: string): string[] {
    if (this.entries.size === 0) return [];
    const textKey = normalizeTextKey(assistantText);
    if (!textKey) return [];
    this.prune(now);
    const assistantTokens = new Set(tokenize(textKey));
    // Empty assistant text after tokenization still allows id citation matches
    // (e.g. the model only wrote a memory id reference).
    const matched: string[] = [];

    // When sessionId is provided, build a set of memory ids that belong to
    // a DIFFERENT session so they can be excluded. Entries recorded without
    // a session, or recorded for the requesting session, remain eligible.
    let otherSessionMemoryIds: Set<string> | undefined;
    if (sessionId) {
      otherSessionMemoryIds = new Set<string>();
      for (const [contextKey] of this.contextEntries) {
        const nullIdx = contextKey.indexOf('\0');
        const entrySession = nullIdx >= 0 ? contextKey.slice(0, nullIdx) : '<no-session>';
        const memoryId = nullIdx >= 0 ? contextKey.slice(nullIdx + 1) : contextKey;
        if (entrySession !== '<no-session>' && entrySession !== sessionId) {
          otherSessionMemoryIds.add(memoryId);
        }
      }
    }

    for (const [memoryId, entry] of this.entries) {
      // Session filter: skip entries that belong to a different session.
      // Entries with no session or the same session remain eligible.
      if (otherSessionMemoryIds?.has(memoryId)) continue;
      // Explicit id citation is the strongest usefulness signal — models often
      // reference `<memory id="…">` without restating the full body.
      if (textKey.includes(normalizeTextKey(memoryId)) || assistantText.includes(memoryId)) {
        matched.push(memoryId);
        this.entries.delete(memoryId);
        continue;
      }
      if (assistantTokens.size === 0) continue;
      // Also accept high containment of the memory's own normalized text when
      // the assistant paraphrases lightly but keeps a long distinctive phrase.
      const phraseHit = entry.textKey.length >= 24 && textKey.includes(entry.textKey.slice(0, 80));
      if (phraseHit) {
        matched.push(memoryId);
        this.entries.delete(memoryId);
        continue;
      }
      // Overlap coefficient (Szymkiewicz–Simpson) using the cached token set.
      // Absolute floor (`minMatchTokens`) kills short-memory false positives
      // where 2 coincidental tokens already clear a 0.5 ratio on a 4-token set.
      let intersection = 0;
      for (const token of entry.tokenSet) {
        if (assistantTokens.has(token)) intersection++;
      }
      const smaller = Math.min(entry.tokenSet.size, assistantTokens.size);
      if (
        intersection >= this.minMatchTokens &&
        smaller > 0 &&
        intersection / smaller >= this.matchThreshold
      ) {
        matched.push(memoryId);
        this.entries.delete(memoryId);
      }
    }
    return matched;
  }

  /** Current number of tracked injections (after pruning). */
  get size(): number {
    this.prune(Date.now());
    return this.entries.size;
  }

  private prune(now: number): void {
    // Overflow eviction is a hard memory bound — always runs.
    if (this.entries.size > this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries;
      let dropped = 0;
      for (const key of this.entries.keys()) {
        if (dropped >= overflow) break;
        this.entries.delete(key);
        dropped++;
      }
    }
    if (this.contextEntries.size > this.maxEntries) {
      const overflow = this.contextEntries.size - this.maxEntries;
      let dropped = 0;
      for (const key of this.contextEntries.keys()) {
        if (dropped >= overflow) break;
        this.contextEntries.delete(key);
        dropped++;
      }
    }

    // TTL sweeps are O(n) over all three maps — throttle to once per
    // interval. The interval is min(PRUNE_INTERVAL_MS, ttlMs) so short-TTL
    // configurations (tests, session-scoped trackers) still prune promptly
    // while the production 2-hour TTL gets the full 30s throttle benefit.
    const interval = Math.min(InjectionTracker.PRUNE_INTERVAL_MS, this.ttlMs);
    if (now - this.lastPruneAt < interval) return;
    this.lastPruneAt = now;

    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
    for (const [key, entry] of this.contextEntries) {
      if (entry.at < cutoff) this.contextEntries.delete(key);
    }
    for (const [key, entry] of this.activeContextBySession) {
      if (entry.at < cutoff) this.activeContextBySession.delete(key);
    }
  }
}

function contextNeedle(
  textKey: string,
  renderedContextText: string | undefined,
  minTokens: number,
): string {
  if (!renderedContextText) return textKey;
  const renderedKey = normalizeTextKey(renderedContextText);
  if (renderedKey.includes(textKey)) return textKey;
  const words = textKey.split(' ');
  while (words.length >= minTokens) {
    const prefix = words.join(' ');
    if (renderedKey.includes(prefix)) return prefix;
    words.pop();
  }
  return textKey;
}
