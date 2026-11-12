import type { Message } from '@wrongstack/contracts/types/messages';
import { isElidedResultContent, isElidedToolInput } from '../utils/elision-markers.js';
import {
  type HistoryRetention,
  RETENTION_CLASSES,
  type RetentionClass,
} from '../utils/residency-labels.js';
import {
  estimateMessageTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';
import { findPreserveStart } from './compaction-elision.js';

/**
 * Which part of the durable conversation survives the next compaction, and
 * which part is already compacted:
 *
 * - `protected`          — inside the preserve window (last `preserveK` turns);
 *                          compaction never rewrites it.
 * - `elision-candidate`  — older turn carrying a tool result above
 *                          `eliseThreshold`; the first thing compaction replaces
 *                          with a receipt.
 * - `compactable`        — older turn; digested only under pressure.
 * - `elided`             — older turn whose tool I/O is already a receipt
 *                          (`[elided:` / `[stale read of …]`).
 * - `digest`             — an in-conversation `system` message: a compaction
 *                          digest or the `[context_state]` evidence floor.
 *
 * Mirrors the compactors' own window (`findPreserveStart`) and the policy
 * defaults of `compaction-history-policy.ts`, so the classes match what
 * compaction will actually do. The class vocabulary lives in
 * `residency-labels.ts` so browser surfaces can import it dependency-free.
 */
export type { HistoryRetention, RetentionClass } from '../utils/residency-labels.js';

const DEFAULT_PRESERVE_K = 6;
const DEFAULT_ELISE_THRESHOLD = 1_200;

function policyNumber(meta: Record<string, unknown> | undefined, key: string): unknown {
  const policy = meta?.['contextWindowPolicy'];
  return policy && typeof policy === 'object'
    ? (policy as Record<string, unknown>)[key]
    : undefined;
}

function resolvePreserveK(meta: Record<string, unknown> | undefined): number {
  const k = policyNumber(meta, 'preserveK');
  return typeof k === 'number' && k > 0 ? Math.floor(k) : DEFAULT_PRESERVE_K;
}

function resolveEliseThreshold(meta: Record<string, unknown> | undefined): number {
  const t = policyNumber(meta, 'eliseThreshold');
  return typeof t === 'number' && Number.isFinite(t) && t >= 0
    ? Math.floor(t)
    : DEFAULT_ELISE_THRESHOLD;
}

function classify(
  message: Message,
  index: number,
  preserveStart: number,
  threshold: number,
): RetentionClass {
  if (message.role === 'system') return 'digest';
  if (index >= preserveStart) return 'protected';
  if (typeof message.content === 'string') return 'compactable';
  // Oversize must be read exactly the way `eliseOldToolResults` reads it: it
  // scans EVERY block of the turn and calls a block oversized at
  // `tokensFor(b) >= eliseThreshold`, where `tokensFor` scores an existing
  // receipt 0 (compaction-elision.ts:467-476 and :489-491). The three
  // shortcuts here each hid a turn from the report while the engine still
  // intended to replace it: bailing out on the first receipt skipped a second,
  // still-oversized block in the same turn; `>` skipped a turn sitting exactly
  // on the threshold; and never sizing `tool_use` inputs skipped a turn whose
  // only oversized block is a large tool argument.
  let candidate = false;
  let receipt = false;
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      if (isElidedResultContent(block.content)) receipt = true;
      else if (estimateToolResultTokens(block.content) >= threshold) candidate = true;
    } else if (block.type === 'tool_use') {
      if (isElidedToolInput(block.input)) receipt = true;
      else if (estimateToolInputTokens(block.input) >= threshold) candidate = true;
    }
  }
  // A turn with work left is a candidate even when part of it is already a
  // receipt; only a turn with nothing left to replace counts as elided.
  if (candidate) return 'elision-candidate';
  return receipt ? 'elided' : 'compactable';
}

export function getHistoryRetention(ctx: {
  messages: readonly Message[];
  meta?: Record<string, unknown> | undefined;
}): HistoryRetention {
  const preserveK = resolvePreserveK(ctx.meta);
  const eliseThreshold = resolveEliseThreshold(ctx.meta);
  const preserveStart = findPreserveStart(ctx.messages, preserveK);
  const classes = Object.fromEntries(
    RETENTION_CLASSES.map((c) => [c, { messages: 0, tokens: 0 }]),
  ) as HistoryRetention['classes'];
  let total = 0;
  ctx.messages.forEach((message, index) => {
    const bucket = classes[classify(message, index, preserveStart, eliseThreshold)];
    const tokens = estimateMessageTokens([message]);
    bucket.messages++;
    bucket.tokens += tokens;
    total += tokens;
  });
  return { preserveK, eliseThreshold, preserveStart, classes, total };
}
