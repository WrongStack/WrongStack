/**
 * `createSageDomainTermExtractorMiddleware` — per-turn wiring of the
 * Project Jargon Dictionary extractor.
 *
 * Architectural role
 * ------------------
 * The `SageDomainTermExtractor` capability lives in `@wrongstack/sage`
 * and can run anywhere there is a SAGE `MemoryPort`. Until now the
 * only callers were tests. This middleware closes the per-turn wiring
 * gap so that, before each provider call, the accumulated
 * conversation is mined for jargon and persisted via the
 * canonical persistence helpers (which perform
 * canonical-text dedup and Last-Writer-Wins updates).
 *
 * Why a middleware and not a one-shot hook?
 * -----------------------------------------
 * The request pipeline is the natural funnel:
 *   `Request -> [turn-context injection] -> ... -> provider request`
 * Running extraction after downstream request middleware guarantees
 * that the snapshot sees their final `Request` while remaining clear
 * of the provider response path. The request already contains prior
 * assistant turns plus the current user turn.
 *
 * Fire-and-forget, by design
 * --------------------------
 * The handler schedules extraction on the microtask queue and
 * returns the transformed request unchanged. Any failure inside
 * extract/persist/mirror is logged through the host's stderr and
 * dropped — extractor mistakes must never abort a turn.
 *
 * Idempotency
 * -----------
 * `persistViaAndMirror` already performs a canonical-name dedup pass and
 * issues an `updateSage` (rather than `rememberSage`) when an entry
 * already exists, so a turn hitting the same glossary twice is a no-op
 * for unchanged terms and an LWW update otherwise. The
 * refreshes the mirror from derived SAGE state when a project root exists.
 */

import type { Middleware } from '@wrongstack/contracts/kernel';
import type { MemoryPort, Request } from '@wrongstack/contracts/types';
import { LIVE_CONTEXT_MARKER, writeErr } from '@wrongstack/core/utils';
import { SageDomainTermExtractor } from '../domain-term-extractor.js';

/**
 * Narrow options type for the extractor middleware — everything is
 * optional so a host can wire the middleware against any subset of
 * the capability. When `memory` is omitted the middleware becomes a
 * no-op (extraction is a no-write capability, so this is the safe
 * default for legacy `MemoryStore` ports).
 */
export interface SageDomainTermExtractorMiddlewareOptions {
  /**
   * Resolved SAGE `MemoryPort`. The extractor requires the SAGE
   * surface; without it the middleware is a pure pass-through.
   */
  memory?: MemoryPort | undefined;
  /**
   * Project root for the `.wrongstack/domain-terms.md` mirror
   * refresh. When provided the middleware regenerates the file after
   * each turn; when omitted the mirror is skipped.
   */
  projectRoot?: string | undefined;
  /**
   * Per-turn minimum candidate confidence. Defaults to the
   * extractor's own default (0.55).
   */
  minConfidence?: number | undefined;
  /**
   * Hard cap on how many candidates may be persisted per turn.
   * Defaults to a small number (8) so an unusually chatty conversation
   * cannot flood the dictionary. Existing terms updated in place do
   * not count against this cap.
   */
  maxTermsPerTurn?: number | undefined;
  /**
   * Optional logger override. Defaults to writing through
   * `@wrongstack/core/utils#writeErr`.
   */
  log?: ((line: string) => void) | undefined;
  /**
   * Extractor factory. Defaults to `() => new SageDomainTermExtractor()`.
   * Overridable so unit tests can inject a fake without monkey-patching
   * the imported class binding.
   */
  extractorFactory?: (() => SageDomainTermExtractor) | undefined;
}

const DEFAULT_MAX_TERMS_PER_TURN = 8;
/** Distinct conversation snapshots remembered as already mined. */
const MAX_MINED_SNAPSHOTS = 64;

function snapshotFingerprint(
  snapshot: ReadonlyArray<{ role: 'user' | 'agent'; text: string }>,
): string {
  let hash = 0x811c9dc5;
  let chars = 0;
  for (const entry of snapshot) {
    const text = `${entry.role}\u0000${entry.text}`;
    chars += text.length;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${snapshot.length}:${chars}:${hash >>> 0}`;
}

/**
 * Middleware factory. Returns a request-pipeline `Middleware` that
 * - never throws;
 * - never blocks the response;
 * - registers a fresh extractor on each call (the extractor is
 *   stateless, so reuse is implicit);
 * - is safe to register alongside `createSageTurnMiddleware` and
 *   other SAGE middlewares (different `name`, no shared state).
 */
export function createSageDomainTermExtractorMiddleware(
  opts: SageDomainTermExtractorMiddlewareOptions,
): Middleware<Request> {
  const log = opts.log ?? ((line: string) => writeErr(`${line}\n`));
  const maxTermsPerTurn = opts.maxTermsPerTurn ?? DEFAULT_MAX_TERMS_PER_TURN;
  // The request pipeline runs once per provider request, so a single turn
  // with a 20-step tool loop re-mined the identical conversation 20 times —
  // a full-transcript scan plus SAGE round-trips per step for no new input.
  // Only user/assistant text feeds the extractor, and tool steps do not change
  // it, so an unchanged snapshot is skipped.
  const minedSnapshots = new Set<string>();
  return {
    name: 'sage.domain-term-extractor',
    owner: 'sage',
    async handler(request, next) {
      // Pass-through ONLY when the port doesn't carry the SAGE surface.
      // `projectRoot` is optional on purpose: a host that wires the
      // middleware without a project root (e.g. the WebUI while the
      // ProjectRoot picker is loading) still wants its conversation
      // mined into SAGE; the on-disk mirror is simply skipped. This
      // keeps the SAGE corpus authoritative on every host that has a
      // port, even before the user has chosen a project.
      if (!opts.memory) {
        return next(request);
      }

      const processed = await next(request);

      let snapshot: ReadonlyArray<{ role: 'user' | 'agent'; text: string }>;
      try {
        snapshot = extractSnapshot(processed);
      } catch {
        return processed;
      }
      const fingerprint = snapshotFingerprint(snapshot);
      if (minedSnapshots.has(fingerprint)) return processed;
      minedSnapshots.add(fingerprint);
      if (minedSnapshots.size > MAX_MINED_SNAPSHOTS) {
        const oldest = minedSnapshots.values().next().value;
        if (oldest !== undefined) minedSnapshots.delete(oldest);
      }

      // Schedule on the microtask queue so the model can stream its
      // response without waiting on extractor latency.
      queueMicrotask(() => {
        void runExtraction({
          memory: opts.memory!,
          projectRoot: opts.projectRoot,
          snapshot,
          minConfidence: opts.minConfidence,
          maxTermsPerTurn,
          log,
          factory: opts.extractorFactory,
        });
      });

      return processed;
    },
  };
}

async function runExtraction(args: {
  memory: MemoryPort;
  projectRoot: string | undefined;
  snapshot: ReadonlyArray<{ role: 'user' | 'agent'; text: string }>;
  minConfidence: number | undefined;
  maxTermsPerTurn: number;
  log: (line: string) => void;
  factory?: (() => SageDomainTermExtractor) | undefined;
}): Promise<void> {
  try {
    const extractor = (args.factory ?? (() => new SageDomainTermExtractor()))();
    const candidates = extractor.extractFromConversation({
      messages: [...args.snapshot],
      minConfidence: args.minConfidence,
      limit: args.maxTermsPerTurn,
    });
    if (candidates.length === 0) return;
    if (args.projectRoot === undefined) {
      await extractor.persistVia(args.memory, candidates, {
        minConfidence: args.minConfidence,
      });
    } else {
      await extractor.persistViaAndMirror(args.memory, candidates, {
        minConfidence: args.minConfidence,
        projectRoot: args.projectRoot,
      });
    }
  } catch (err) {
    args.log(
      `[sage] domain-term extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Minimal message snapshot. Only `user` and `assistant` messages are
 * considered; system/tool messages are skipped (system is constant,
 * tool messages were already covered by the previous turn). The text
 * is whatever the host stored on the message — most pipelines keep
 * plain strings. The `assistant` role is mapped to the extractor
 * surface's `agent` role at the boundary so the snapshot carries a
 * single canonical role vocabulary end-to-end.
 */
function extractSnapshot(
  request: Request,
): ReadonlyArray<{ role: 'user' | 'agent'; text: string }> {
  const out: Array<{ role: 'user' | 'agent'; text: string }> = [];
  const messages = request.messages ?? [];
  for (const msg of messages) {
    const role = (msg as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(msg);
    if (!text) continue;
    out.push({ role: role === 'assistant' ? 'agent' : 'user', text });
  }
  return out;
}

function messageText(message: unknown): string {
  const m = message as { content?: unknown; authoredLength?: unknown };
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Host-written text shares user messages with the author's: notes folded
    // in after the input (past `authoredLength`; in a tool-result carrier every
    // text block) and the `[live_context]` tail (glossary, plan, memory
    // evidence). Mining it re-persists the host's own injection — the glossary
    // is built from these terms — as if the user had said it.
    const blocks =
      typeof m.authoredLength === 'number' ? content.slice(0, m.authoredLength) : content;
    const toolCarrier =
      typeof m.authoredLength !== 'number' &&
      blocks.some((block) => (block as { type?: unknown } | null)?.type === 'tool_result');
    let acc = '';
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === 'text' && b.text === LIVE_CONTEXT_MARKER) break;
      if (b.type === 'text' && toolCarrier) continue;
      const piece =
        b.type === 'text' && typeof b.text === 'string'
          ? b.text
          : typeof b.content === 'string'
            ? b.content
            : '';
      if (piece) {
        acc += acc && !acc.endsWith(' ') && !piece.startsWith(' ') ? ` ${piece}` : piece;
      }
    }
    return acc;
  }
  return '';
}
