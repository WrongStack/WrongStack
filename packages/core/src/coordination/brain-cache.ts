/**
 * Decision cache for the expensive Brain tiers.
 *
 * Autonomy workloads ask the same question over and over: a goal-completion
 * check every phase, a budget-extension question per subagent, a
 * monitor engagement per repeated signal. Each one used to be a fresh
 * council/LLM call even when nothing about the situation had changed, which
 * is the single largest avoidable source of Brain token spend.
 *
 * Scope is deliberately narrow — the cache exists to skip PROVIDER calls, not
 * to replace judgement:
 *
 *   - Only decisions produced by the `council` / `llm` tiers are stored. A
 *     deterministic tier is already free, so caching it would add lookup cost
 *     and staleness for no gain.
 *   - `ask_human` is never cached: it is a request for input, not a verdict.
 *   - An observed FAILURE outcome for a cached decision evicts it. This is
 *     what stops the cache from cementing a bad call: the ledger already
 *     correlates outcomes, so a decision that demonstrably went wrong will
 *     not be replayed.
 *   - Entries expire on a TTL, so a stale world eventually re-asks anyway.
 *
 * The key includes everything that could change the right answer — question
 * shape, source, risk, fallback, and the exact option set — so two questions
 * that merely look similar do not share a verdict.
 *
 * @module brain-cache
 */

import type { EventBus } from '../kernel/events.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from './brain.js';
import { brainDecisionKey } from './brain-ledger.js';
import { emitBrainTierTransition, markDecisionTier, readDecisionTier } from './brain-telemetry.js';

export interface BrainDecisionCacheOptions {
  /** Master switch. Default false — caching a judgement is opt-in. */
  enabled?: boolean | undefined;
  /** Entry lifetime in ms. Default 300_000 (5 min). */
  ttlMs?: number | undefined;
  /** Maximum live entries; oldest evicted first. Default 200. */
  maxEntries?: number | undefined;
  /**
   * Outcome feed. When a cached decision is later observed to have FAILED,
   * its entry is dropped so the mistake is not replayed.
   */
  events?: EventBus | undefined;
  /** Override the clock for deterministic tests. */
  now?: (() => number) | undefined;
}

interface CacheEntry {
  decision: BrainDecision;
  storedAt: number;
  /** Request ids served from (or that produced) this entry, for outcome eviction. */
  requestIds: Set<string>;
}

export interface BrainCacheStats {
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
  size: number;
}

/**
 * Build the cache key for a request.
 *
 * Reuses `brainDecisionKey` for the question so id/number-shaped tokens
 * collapse (the same question about two different subagents shares an entry),
 * then adds every other field that can legitimately change the answer.
 */
export function brainCacheKey(request: BrainDecisionRequest): string {
  const options = (request.options ?? [])
    .map((option) => option.id)
    .sort()
    .join(',');
  return [
    brainDecisionKey(request.source, request.question),
    request.risk,
    request.fallback,
    options,
  ].join('|');
}

/** Tiers whose decisions cost a provider call and are therefore worth caching. */
const CACHEABLE_TIERS = new Set(['council', 'llm']);

export class BrainDecisionCache {
  /**
   * Max request ids retained per cached entry. Served (replayed) request ids
   * are kept only so a later `brain.outcome` failure can evict the verdict;
   * past this cap the oldest ids are dropped — the entry itself stays.
   */
  private static readonly MAX_REQUEST_IDS_PER_ENTRY = 500;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly keyByRequestId = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];
  private stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly opts: BrainDecisionCacheOptions = {}) {
    this.enabled = opts.enabled === true;
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 200;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Delete an entry and every request-id index mapping that points at it.
   * Every eviction path (TTL expiry, max-entry eviction, outcome failure,
   * same-key replacement) must go through this so `keyByRequestId` cannot
   * outlive its entry — otherwise the index grows one string per unique
   * request id for the process lifetime.
   */
  private removeEntry(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    // Only drop index mappings that still point at THIS entry. A request id
    // that was re-stored under a different key keeps its newer mapping.
    for (const requestId of entry.requestIds) {
      if (this.keyByRequestId.get(requestId) === key) this.keyByRequestId.delete(requestId);
    }
    this.entries.delete(key);
    return true;
  }

  /** Subscribe to the outcome feed so failures evict their decision. */
  start(): void {
    if (!this.enabled || !this.opts.events) return;
    this.unsubscribers.push(
      this.opts.events.on('brain.outcome', (e) => {
        if (e.outcome !== 'failure') return;
        const key = this.keyByRequestId.get(e.requestId);
        if (key === undefined) return;
        // The world disagreed with this verdict — do not serve it again.
        if (this.removeEntry(key)) this.stats.evictions += 1;
      }),
    );
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  get(request: BrainDecisionRequest): BrainDecision | undefined {
    if (!this.enabled) return undefined;
    const key = brainCacheKey(request);
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.removeEntry(key);
      this.stats.evictions += 1;
      this.stats.misses += 1;
      return undefined;
    }
    // Bound the per-entry served-request-id set so replay tracking cannot grow
    // without limit on hot entries (outcome eviction needs only recent ids).
    if (entry.requestIds.size >= BrainDecisionCache.MAX_REQUEST_IDS_PER_ENTRY) {
      const oldest = entry.requestIds.values().next().value;
      if (oldest !== undefined) {
        entry.requestIds.delete(oldest);
        this.keyByRequestId.delete(oldest);
      }
    }
    entry.requestIds.add(request.id);
    this.keyByRequestId.set(request.id, key);
    this.stats.hits += 1;
    return entry.decision;
  }

  /**
   * Store a decision if it is worth caching. Returns true when stored.
   * Callers pass the tier that produced it — a deterministic tier is free to
   * recompute, and `ask_human` is a request for input rather than a verdict.
   */
  set(request: BrainDecisionRequest, decision: BrainDecision, tier: string | undefined): boolean {
    if (!this.enabled) return false;
    if (decision.type === 'ask_human') return false;
    if (tier === undefined || !CACHEABLE_TIERS.has(tier)) return false;

    const key = brainCacheKey(request);
    // Replace any existing entry for this key first, so the superseded
    // entry's request-id index mappings do not outlive it.
    this.removeEntry(key);
    this.entries.set(key, {
      decision,
      storedAt: this.now(),
      requestIds: new Set([request.id]),
    });
    this.keyByRequestId.set(request.id, key);
    this.stats.stores += 1;

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.removeEntry(oldest.value);
      this.stats.evictions += 1;
    }
    return true;
  }

  snapshot(): BrainCacheStats {
    return { ...this.stats, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.keyByRequestId.clear();
  }
}

export interface CachingBrainArbiterOptions {
  inner: BrainArbiter;
  cache: BrainDecisionCache;
  /**
   * Bus for the `brain.tier_transition` step recorded on a cache HIT. A
   * replayed verdict is otherwise the one outcome with no ladder steps at
   * all, which reads in the trace exactly like a decision that never ran.
   */
  events?: EventBus | undefined;
}

/**
 * Wrap an arbiter so repeated identical questions replay a previous
 * provider-backed verdict instead of paying for it again.
 *
 * Position INSIDE the ledger guard: a guard denial must always be evaluated
 * against the live failure history, never served from a cache.
 */
export function createCachingBrainArbiter(opts: CachingBrainArbiterOptions): BrainArbiter {
  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const startedAt = Date.now();
      const hit = opts.cache.get(request);
      if (hit) {
        markDecisionTier(request, 'cache');
        emitBrainTierTransition(
          opts.events,
          request,
          'cache',
          hit.type,
          true,
          startedAt,
          'replayed a cached verdict',
        );
        return hit;
      }
      const decision = await opts.inner.decide(request);
      // Read the tier the inner chain recorded — that is what tells us
      // whether this decision actually cost anything.
      opts.cache.set(request, decision, readDecisionTier(request));
      return decision;
    },
  };
}
