import type { SessionEventMap } from '@wrongstack/contracts/kernel/events/session-events';
import { isVolatileSystemBlock, type TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { formatMemoryEvidenceBlock } from '../utils/memory-evidence-fence.js';
import {
  getRequestResidency,
  liveBlockSource,
  type RequestLayoutTailEntry,
  recordRequestLayout,
} from '../utils/request-layout.js';
import type { Context } from './context.js';

/**
 * Render memory retrieval as volatile provider evidence, not conversation
 * history. Keeping it after the stable base prompt preserves cache reuse while
 * making the provenance boundary explicit to the model.
 *
 * Every retrieved entry goes in whole. Which memories are relevant is the
 * retrieval layer's decision (its own relevance floor); a fixed character cut
 * here silently dropped memories it had already chosen.
 */
export function buildMemoryEvidenceBlocks(ctx: Pick<Context, 'memoryEvidence'>): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const entry of ctx.memoryEvidence) {
    const text = entry.text.trim();
    if (!text) continue;
    // `formatMemoryEvidenceBlock` owns the fence and neutralizes the delimiter
    // inside the body — memory text is attacker-influenceable, and a literal
    // `[/memory_evidence]` in it would otherwise close the block early and
    // leave the rest as unfenced live-context text.
    blocks.push({ type: 'text', text: formatMemoryEvidenceBlock(entry.source, text) });
  }
  return blocks;
}

/**
 * The live-context tail of one request, with provenance. Built where the
 * request is composed so the residency report names every block it carried
 * (the epoch-volatile copies carry no `SYSTEM_BLOCK_SOURCE` tag of their own).
 */
export function liveTailEntriesOf(parts: {
  epochTail: readonly TextBlock[];
  epochSources: readonly string[];
  ledger: TextBlock | undefined;
  missionAnchor: TextBlock | undefined;
  continuity: TextBlock | undefined;
  nextsteps: TextBlock | undefined;
  memoryEvidence: readonly TextBlock[];
}): RequestLayoutTailEntry[] {
  const entries: RequestLayoutTailEntry[] = parts.epochTail.map((block, i) => ({
    source: parts.epochSources[i] ?? 'epoch',
    block,
  }));
  if (parts.ledger) entries.push({ source: 'ledger', block: parts.ledger });
  if (parts.missionAnchor) {
    entries.push({ source: 'mission-anchor', block: parts.missionAnchor });
  }
  if (parts.continuity) entries.push({ source: 'continuity', block: parts.continuity });
  if (parts.nextsteps) entries.push({ source: 'nextsteps', block: parts.nextsteps });
  for (const block of parts.memoryEvidence) entries.push({ source: 'memory-evidence', block });
  return entries;
}

/**
 * Record the final request for the residency report (`getRequestResidency`).
 * `volatile` are the middleware-added blocks the request pipeline put in
 * `system`; they were re-homed into the live tail, or replayed with it.
 * `ephemeral` are request-scoped blocks (raw mail) sent once and never kept;
 * on automatic-cache wires `replayed` is the message array before they were
 * appended, which is what the next request's prefix is compared against.
 */
export function captureRequestLayout(
  request: Request,
  provider: Provider,
  liveTail: readonly RequestLayoutTailEntry[],
  volatile: readonly TextBlock[],
  history: readonly Message[],
  extra: {
    durableMessages: readonly Message[];
    ephemeral: readonly RequestLayoutTailEntry[];
    replayed?: readonly Message[] | undefined;
  },
): void {
  const tailBlocks = new Set<TextBlock>(
    [...liveTail, ...extra.ephemeral].map((entry) => entry.block),
  );
  recordRequestLayout(request, {
    providerId: provider.id,
    model: request.model,
    cacheControl: provider.capabilities.cacheControl,
    tools: request.tools ?? [],
    // Without history the live tail rides in `system` (legacy placement); it
    // is accounted as live context, not as the cached prefix.
    system: (request.system ?? []).filter(
      (block) => !tailBlocks.has(block) && !isVolatileSystemBlock(block),
    ),
    history,
    messages: extra.replayed ?? request.messages,
    ephemeral: extra.ephemeral,
    tail: [
      ...liveTail,
      ...volatile.map(
        (block): RequestLayoutTailEntry => ({ source: liveBlockSource(block), block }),
      ),
    ],
    durableMessages: extra.durableMessages,
  });
}

/** Structural emitter — keeps this module free of the kernel EventBus type. */
interface ResidencyEmitter {
  emit(type: 'context.residency', payload: ContextResidencyEvent): void;
}

type ContextResidencyEvent = SessionEventMap['context.residency'];

/**
 * Publish the residency of the request that was just answered, so Chronicle
 * (and through it the WebUI session story) holds one data point per request.
 * Display-only: a failure here must never reach the agent loop.
 */
export function publishRequestResidency(
  events: ResidencyEmitter,
  ctx: Context,
  sessionId: string | undefined,
): void {
  try {
    const r = getRequestResidency(ctx);
    if (!r?.actual) return;
    const metaLimit = ctx.meta?.['effectiveMaxContext'];
    const providerMax = ctx.provider?.capabilities?.maxContext;
    events.emit('context.residency', {
      sessionId,
      agentId: ctx.agentId,
      seq: r.seq,
      provider: r.providerId,
      model: r.model,
      mechanism: r.mechanism,
      maxContext:
        typeof metaLimit === 'number' && metaLimit > 0
          ? metaLimit
          : typeof providerMax === 'number' && providerMax > 0
            ? providerMax
            : 0,
      total: r.total,
      cached: r.lanes.cached,
      written: r.lanes.written,
      uncached: r.lanes.uncached,
      usageInput: r.actual.input,
      usageCacheRead: r.actual.cacheRead,
      usageCacheWrite: r.actual.cacheWrite,
      verdict: r.verdict,
      breakers: r.breakers.map((b) => b.kind),
      segments: r.segments.map((s) => ({
        kind: s.kind,
        tokens: s.tokens,
        lane: s.lane,
        count: s.count,
      })),
      live: r.segments.flatMap((s) => s.parts ?? []).slice(0, 12),
      historyMessages: r.segments
        .filter((s) => s.kind === 'history-prior' || s.kind === 'history-new')
        .reduce((sum, s) => sum + s.count, 0),
    });
  } catch {
    // Residency is observability; never let it disturb the request path.
  }
}
