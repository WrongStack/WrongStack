import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import { effectiveInputTokens, type Usage } from '@wrongstack/contracts/types/provider';
import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolDefTokens,
} from './token-estimate.js';

/**
 * Request residency — which part of the LAST request the provider could serve
 * from its prompt cache, which part it had to (re)write, and which part is
 * per-request live state that is never cached.
 *
 * `getContextBreakdown` measures `ctx`; the wire request is assembled very
 * differently from it (epoch-volatile system blocks re-homed behind the cache
 * boundary, continuity/memory evidence/middleware blocks added, delivered
 * `<nextsteps>` stripped, automatic-cache live snapshots replayed in place).
 * This module records the request exactly as the agent composed it, at the
 * single chokepoint that builds it, and pairs it with the provider's real
 * `usage` once the response lands. Recording keeps references only; every
 * token walk happens lazily when a surface asks for the residency.
 */

/** How the active wire caches the prompt prefix. */
export type CacheMechanism = 'explicit' | 'automatic' | 'none';

/**
 * Expected cache placement of a request segment:
 * - `cached`   — byte-identical prefix of the previous request; served from cache.
 * - `written`  — new prefix bytes; billed fresh now, cacheable for the next request.
 * - `uncached` — never part of a reusable prefix (per-request live state, or no cache).
 */
export type CacheLane = 'cached' | 'written' | 'uncached';

export type ResidencySegmentKind =
  | 'tools'
  | 'system'
  | 'history-prior'
  | 'history-new'
  | 'live-snapshots'
  | 'live-tail'
  | 'request-scoped';

export interface ResidencySegment {
  kind: ResidencySegmentKind;
  tokens: number;
  lane: CacheLane;
  /** Tool definitions, system blocks, messages or live blocks in the segment. */
  count: number;
  /** Per-source token split of a live segment, largest first. */
  parts?: Array<{ source: string; tokens: number }> | undefined;
}

/**
 * Why cached bytes were not reused. `provider` means nothing changed on our
 * side — the provider did not serve an unchanged prefix (still warming,
 * evicted, or routed elsewhere); every other kind is a change we made.
 */
export type CacheBreakerKind = 'route' | 'tools' | 'system' | 'history' | 'idle' | 'provider';

export interface CacheBreaker {
  kind: CacheBreakerKind;
  detail: string;
}

export type CacheVerdict = 'pending' | 'cold' | 'hit' | 'partial' | 'miss' | 'unsupported';

export interface RequestResidency {
  seq: number;
  at: number;
  providerId: string;
  model: string;
  mechanism: CacheMechanism;
  /** Wire order: tools → system → history → live context. */
  segments: ResidencySegment[];
  lanes: Record<CacheLane, number>;
  /** Estimated request tokens (sum of segments). */
  total: number;
  /** lanes.cached / total — what the layout allows the cache to serve. */
  expectedCacheRatio: number;
  /** Provider-reported usage of this request; absent until the response lands. */
  actual?:
    | {
        input: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
        cacheRatio: number;
      }
    | undefined;
  verdict: CacheVerdict;
  /** What changed versus the previous request in a way that voids cached bytes. */
  breakers: CacheBreaker[];
  sincePreviousMs?: number | undefined;
  /** What the NEXT request will look like relative to this one. */
  next: {
    /** The durable history was rewritten (compaction, rewind, repair, /clear). */
    rewritten: boolean;
    pendingMessages: number;
    pendingTokens: number;
  };
}

export interface RequestLayoutTailEntry {
  /** Provenance label (`plan`, `ledger`, `memory-evidence`, a middleware tag, …). */
  source: string;
  block: TextBlock;
}

export interface RequestLayoutInput {
  providerId: string;
  model: string;
  cacheControl: 'native' | 'auto' | 'none';
  tools: readonly Tool[];
  /** Wire `system` blocks (the cache-stable prefix). */
  system: readonly TextBlock[];
  /** Durable conversation as sent, before live-context composition. */
  history: readonly Message[];
  /** Final wire messages (history + live context). */
  messages: readonly Message[];
  /** Live-context blocks of this request with their provenance. */
  tail: readonly RequestLayoutTailEntry[];
  /** Request-scoped blocks (raw mail): sent once, never replayed or kept. */
  ephemeral?: readonly RequestLayoutTailEntry[] | undefined;
  /** `ctx.messages` at build time — used to tell what the NEXT request adds. */
  durableMessages: readonly Message[];
}

interface LayoutRecord extends RequestLayoutInput {
  seq: number;
  at: number;
  durableCount: number;
  durableLast: Message | undefined;
  usage?: Usage | undefined;
}

interface LayoutSlot {
  current: LayoutRecord;
  previous?: LayoutRecord | undefined;
}

/** Previous-request gap after which the default (5 min) provider cache TTL has lapsed. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/** Actual coverage within this fraction of the expected coverage counts as a hit. */
const HIT_TOLERANCE = 0.85;

/** With no expected prefix, a read covering this share of the prompt is still a hit. */
const WARM_READ_RATIO = 0.5;

/** Below this fraction of the expected coverage a read is a miss, not a partial hit. */
const MISS_TOLERANCE = 0.2;

const slots = new WeakMap<object, LayoutSlot>();
const byRequest = new WeakMap<object, LayoutRecord>();

/**
 * Record a composed request. Cheap: stores references, no token walk. A
 * request built but never sent (pre-flight compaction rebuilds it) stays out
 * of the residency until {@link commitRequestLayout} marks it sent.
 */
export function recordRequestLayout(request: object, input: RequestLayoutInput): void {
  if (byRequest.has(request)) return;
  byRequest.set(request, {
    ...input,
    // Snapshot: the history handed in can be the live `ctx.messages` array
    // (nothing stripped), which keeps growing after the request is sent.
    history: input.history.slice(),
    messages: input.messages.slice(),
    ephemeral: input.ephemeral?.slice(),
    durableMessages: [],
    seq: 0,
    at: 0,
    durableCount: input.durableMessages.length,
    durableLast: input.durableMessages[input.durableMessages.length - 1],
  });
}

/**
 * Mark a recorded request as sent for `ctx`; it becomes the residency's
 * current request and the one it replaces becomes the cache baseline. A
 * retried request is the same object and is committed once.
 */
export function commitRequestLayout(ctx: object, request: object, now: number = Date.now()): void {
  const record = byRequest.get(request);
  if (!record || record.seq > 0) return;
  const slot = slots.get(ctx);
  // Numbered per context: the n-th request THIS agent sent, not a global id.
  record.seq = (slot?.current.seq ?? 0) + 1;
  record.at = now;
  slots.set(ctx, { current: record, previous: slot?.current });
}

/** Attach the provider's reported usage to the request it belongs to. */
export function recordRequestLayoutUsage(request: object, usage: Usage | undefined): void {
  const record = byRequest.get(request);
  if (record && usage) record.usage = usage;
}

/** Drop the recorded layouts, e.g. when the conversation is replaced wholesale. */
export function forgetRequestLayout(ctx: object): void {
  slots.delete(ctx);
}

function mechanismOf(cacheControl: RequestLayoutInput['cacheControl']): CacheMechanism {
  return cacheControl === 'native' ? 'explicit' : cacheControl === 'auto' ? 'automatic' : 'none';
}

function sameTools(a: readonly Tool[], b: readonly Tool[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Tool;
    const y = b[i] as Tool;
    if (x === y) continue;
    if (
      x.name !== y.name ||
      x.description !== y.description ||
      JSON.stringify(x.inputSchema) !== JSON.stringify(y.inputSchema)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `cache_control` is wire state, not decoration: it marks the breakpoint the
 * provider may serve from cache. Two blocks with identical text but different
 * markers are NOT a byte-identical prefix, so comparing text alone reports a
 * `cached` lane the wire cannot deliver — and, on the resulting miss,
 * `attributeBreakers` blames the provider for a change we made ourselves.
 *
 * Only the declared `type` is compared: this layer runs before providers add
 * their own wire fields (`ttl`) to the marker.
 */
function sameCacheControl(a: TextBlock['cache_control'], b: TextBlock['cache_control']): boolean {
  return a?.type === b?.type;
}

function sameSystem(a: readonly TextBlock[], b: readonly TextBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as TextBlock;
    const y = b[i] as TextBlock;
    if (x !== y && (x.text !== y.text || !sameCacheControl(x.cache_control, y.cache_control))) {
      return false;
    }
  }
  return true;
}

/**
 * Same wire bytes. Identity is the fast path; hosts routinely swap a message
 * for a copy after a turn (journal round-trips, resume stamps `ts`/`origin`)
 * and the provider cache only sees bytes — so an identity miss compares just
 * what adapters serialize: `role` and `content`.
 */
function sameMessage(a: Message | undefined, b: Message | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.role !== b.role) return false;
  if (a.content === b.content) return true;
  try {
    return JSON.stringify(a.content, wireKeys) === JSON.stringify(b.content, wireKeys);
  } catch {
    return false;
  }
}

/** Drops host-private bookkeeping (`_estTokens`, …) that never reaches the wire. */
function wireKeys(key: string, value: unknown): unknown {
  return key.startsWith('_') ? undefined : value;
}

/** Length of the byte-equal prefix two message arrays share. */
function commonPrefix(a: readonly Message[], b: readonly Message[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && sameMessage(a[i], b[i])) i++;
  return i;
}

function messagesTokens(messages: readonly Message[]): number {
  return estimateMessageTokens(messages);
}

function tailParts(tail: readonly RequestLayoutTailEntry[]): {
  tokens: number;
  parts: Array<{ source: string; tokens: number }>;
} {
  const bySource = new Map<string, number>();
  let tokens = 0;
  for (const entry of tail) {
    const t = estimateTextTokens(entry.block.text);
    tokens += t;
    bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + t);
  }
  const parts = [...bySource]
    .map(([source, t]) => ({ source, tokens: t }))
    .sort((x, y) => y.tokens - x.tokens);
  return { tokens, parts };
}

function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes} min since the previous request` : 'under a minute';
}

/** `: user 1,204 → 1,180 chars` — enough to tell a dropped block from a reformat. */
function describeChange(before: Message | undefined, after: Message | undefined): string {
  const size = (m: Message | undefined): string => {
    if (!m) return 'gone';
    try {
      return `${JSON.stringify(m.content, wireKeys).length.toLocaleString('en-US')} chars`;
    } catch {
      return '?';
    }
  };
  return `: ${before?.role ?? after?.role ?? '?'} ${size(before)} → ${size(after)}`;
}

function findBreakers(
  record: LayoutRecord,
  previous: LayoutRecord | undefined,
  priorCount: number,
): { breakers: CacheBreaker[]; toolsSame: boolean; systemSame: boolean } {
  const breakers: CacheBreaker[] = [];
  if (!previous) return { breakers, toolsSame: false, systemSame: false };
  if (previous.providerId !== record.providerId || previous.model !== record.model) {
    breakers.push({
      kind: 'route',
      detail: `${previous.providerId}/${previous.model} → ${record.providerId}/${record.model}`,
    });
  }
  const toolsSame = sameTools(previous.tools, record.tools);
  if (!toolsSame) {
    breakers.push({
      kind: 'tools',
      detail: `tool surface changed (${previous.tools.length} → ${record.tools.length} definitions)`,
    });
  }
  const systemSame = sameSystem(previous.system, record.system);
  if (!systemSame) breakers.push({ kind: 'system', detail: 'stable system prompt changed' });
  if (priorCount < previous.history.length) {
    breakers.push({
      kind: 'history',
      detail: `history rewritten from message ${priorCount + 1}${describeChange(
        previous.history[priorCount],
        record.history[priorCount],
      )} (compaction, rewind, repair or an in-place edit)`,
    });
  }
  const gap = record.at - previous.at;
  if (gap > DEFAULT_CACHE_TTL_MS) breakers.push({ kind: 'idle', detail: describeGap(gap) });
  return { breakers, toolsSame, systemSame };
}

/**
 * Split the automatic-cache wire messages into replayed live snapshots: the
 * ones inside the reused prefix (cached) and the ones after it (written).
 */
function autoSnapshots(
  record: LayoutRecord,
  priorCount: number,
): { cached: Message[]; written: Message[] } {
  const historySet = new Set<Message>(record.history);
  const cached: Message[] = [];
  const written: Message[] = [];
  let seen = 0;
  for (const message of record.messages) {
    if (historySet.has(message)) {
      seen++;
      continue;
    }
    (seen <= priorCount && seen < record.history.length ? cached : written).push(message);
  }
  return { cached, written };
}

/**
 * An idle gap only explains a miss — on a hit it is noise. A miss or partial
 * read with nothing changed on our side is the provider's: say so instead of
 * leaving the reader to suspect the prompt.
 */
function attributeBreakers(
  verdict: CacheVerdict,
  breakers: CacheBreaker[],
  previous: LayoutRecord | undefined,
): CacheBreaker[] {
  if (verdict === 'hit') return breakers.filter((b) => b.kind !== 'idle');
  if ((verdict === 'miss' || verdict === 'partial') && breakers.length === 0) {
    return [
      {
        kind: 'provider',
        detail:
          previous && !previous.usage
            ? 'prefix unchanged, but the previous request got no response (error or abort), so it may never have written its cache entry'
            : 'prefix unchanged on our side — the provider did not serve it (cache still warming, evicted, or routed to another cache node)',
      },
    ];
  }
  return breakers;
}

function verdictOf(
  mechanism: CacheMechanism,
  usage: Usage | undefined,
  previous: LayoutRecord | undefined,
  expectedRatio: number,
  actualRatio: number,
): CacheVerdict {
  if (!usage) return 'pending';
  const cacheRead = usage.cacheRead ?? 0;
  if (mechanism === 'none' && cacheRead === 0) return 'unsupported';
  if (expectedRatio <= 0) {
    // Nothing reusable was expected (first request of this process, or every
    // prefix byte changed). A substantial read means the provider still held
    // an earlier process's prefix; a sliver (a provider-internal preamble) is
    // not a hit.
    if (actualRatio >= WARM_READ_RATIO) return 'hit';
    return previous ? 'miss' : 'cold';
  }
  if (cacheRead === 0) return 'miss';
  if (actualRatio >= expectedRatio * HIT_TOLERANCE) return 'hit';
  // A sliver of the expected coverage (often a provider-internal preamble) is
  // a miss, not a partial reuse.
  return actualRatio < expectedRatio * MISS_TOLERANCE ? 'miss' : 'partial';
}

/**
 * Residency of the last recorded request for `ctx`, or undefined before the
 * first request. O(messages) — call from interactive surfaces, not per token.
 */
export function getRequestResidency(ctx: {
  messages: readonly Message[];
}): RequestResidency | undefined {
  const slot = slots.get(ctx);
  if (!slot) return undefined;
  const record = slot.current;
  const previous = slot.previous;
  const mechanism = mechanismOf(record.cacheControl);

  const priorCount = previous ? commonPrefix(previous.history, record.history) : 0;
  const { breakers, toolsSame, systemSame } = findBreakers(record, previous, priorCount);
  const routeSame = !breakers.some((b) => b.kind === 'route');
  const prefixIntact = !!previous && routeSame && toolsSame && systemSame;
  const fresh: CacheLane = mechanism === 'none' ? 'uncached' : 'written';
  const reuse = (intact: boolean): CacheLane =>
    mechanism === 'none' ? 'uncached' : intact ? 'cached' : 'written';

  const segments: ResidencySegment[] = [];
  segments.push({
    kind: 'tools',
    tokens: record.tools.reduce((sum, tool) => sum + estimateToolDefTokens(tool), 0),
    lane: reuse(!!previous && routeSame && toolsSame),
    count: record.tools.length,
  });
  segments.push({
    kind: 'system',
    tokens: record.system.reduce((sum, block) => sum + estimateTextTokens(block.text), 0),
    lane: reuse(prefixIntact),
    count: record.system.length,
  });

  const reusedHistory = prefixIntact ? priorCount : 0;
  const prior = record.history.slice(0, reusedHistory);
  const added = record.history.slice(reusedHistory);
  if (prior.length > 0) {
    segments.push({
      kind: 'history-prior',
      tokens: messagesTokens(prior),
      lane: reuse(true),
      count: prior.length,
    });
  }
  if (added.length > 0) {
    segments.push({
      kind: 'history-new',
      tokens: messagesTokens(added),
      lane: fresh,
      count: added.length,
    });
  }

  if (mechanism === 'automatic') {
    const snaps = autoSnapshots(record, reusedHistory);
    if (snaps.cached.length > 0) {
      segments.push({
        kind: 'live-snapshots',
        tokens: messagesTokens(snaps.cached),
        lane: 'cached',
        count: snaps.cached.length,
      });
    }
    if (snaps.written.length > 0) {
      const { parts } = tailParts(record.tail);
      segments.push({
        kind: 'live-tail',
        tokens: messagesTokens(snaps.written),
        lane: 'written',
        count: snaps.written.length,
        parts: parts.length > 0 ? parts : undefined,
      });
    }
  } else if (record.tail.length > 0) {
    const { tokens, parts } = tailParts(record.tail);
    segments.push({
      kind: 'live-tail',
      tokens,
      lane: 'uncached',
      count: record.tail.length,
      parts,
    });
  }

  if (record.ephemeral && record.ephemeral.length > 0) {
    const { tokens, parts } = tailParts(record.ephemeral);
    segments.push({
      kind: 'request-scoped',
      tokens,
      lane: 'uncached',
      count: record.ephemeral.length,
      parts,
    });
  }

  const lanes: Record<CacheLane, number> = { cached: 0, written: 0, uncached: 0 };
  let total = 0;
  for (const seg of segments) {
    lanes[seg.lane] += seg.tokens;
    total += seg.tokens;
  }
  const expectedCacheRatio = total > 0 ? lanes.cached / total : 0;

  let actual: RequestResidency['actual'];
  if (record.usage) {
    const usageTotal = effectiveInputTokens(record.usage);
    const cacheRead = record.usage.cacheRead ?? 0;
    actual = {
      input: record.usage.input,
      cacheRead,
      cacheWrite: record.usage.cacheWrite ?? 0,
      total: usageTotal,
      cacheRatio: usageTotal > 0 ? cacheRead / usageTotal : 0,
    };
  }
  const verdict = verdictOf(
    mechanism,
    record.usage,
    previous,
    expectedCacheRatio,
    actual?.cacheRatio ?? 0,
  );

  const live = ctx.messages;
  const rewritten =
    live.length < record.durableCount ||
    (record.durableCount > 0 && !sameMessage(live[record.durableCount - 1], record.durableLast));
  const pending = rewritten ? [] : live.slice(record.durableCount);

  return {
    seq: record.seq,
    at: record.at,
    providerId: record.providerId,
    model: record.model,
    mechanism,
    segments,
    lanes,
    total,
    expectedCacheRatio,
    actual,
    verdict,
    breakers: attributeBreakers(verdict, breakers, previous),
    sincePreviousMs: previous ? record.at - previous.at : undefined,
    next: {
      rewritten,
      pendingMessages: pending.length,
      pendingTokens: messagesTokens(pending),
    },
  };
}

/**
 * Provenance label for a middleware-added live block: its leading `<tag>` or
 * `[tag]` when it has one (SAGE turn memory, skill recommendations, …).
 */
export function liveBlockSource(block: TextBlock, fallback = 'middleware'): string {
  const match = /^\s*[<[]([a-z][a-z0-9_-]{1,40})/i.exec(block.text);
  return match?.[1]?.toLowerCase() ?? fallback;
}
