/**
 * How much raw event detail Chronicle keeps, and what happens to the rest.
 *
 * The journal used to offer two settings per event class: store it verbatim,
 * or never collect it at all (`domain-adapter.ts`'s allowlist). That leaves no
 * room for the common case -- an event whose *occurrence* is worth counting but
 * whose *content* is identical every time. Measured on a live 4-day journal:
 *
 * - `permission.evaluated` -- 7.6 MB across 5 934 events. Under YOLO every one
 *   of them reads `auto/auto/yolo/allow`; the interesting ones (a denial, an
 *   operator prompt, a downgraded capability) are a rounding error beside them.
 * - `iteration.started` / `iteration.completed` -- 7.8 MB across 7 918 events
 *   to record `{sessionId, index}`. The envelope is 95% of each row.
 * - `token.accounted` -- 4.8 MB across 3 983 events, each a *cumulative* total
 *   that supersedes the one before it. Only the newest is ever read.
 *
 * Folding those into periodic `metrics.counter` aggregates (see
 * `counter-sink.ts`) keeps every question they can answer -- how many tool
 * calls this session, how many denials, what the token totals are -- while
 * dropping ~20 MB of rows that differ only in their timestamps.
 *
 * The levels:
 * - `full`     -- nothing is folded; every collected event is stored raw.
 * - `balanced` -- the default. Folds only events carrying no information beyond
 *                 their own occurrence, and never folds a failure, a denial or
 *                 anything an audit would go looking for.
 * - `lean`     -- also folds the routine half of the tool lifecycle and
 *                 external file notifications, keeping raw rows for calls that
 *                 failed.
 */
import type { ChronicleEventInput } from './types.js';

export type ChronicleDetailLevel = 'full' | 'balanced' | 'lean';

export const CHRONICLE_DETAIL_LEVELS: readonly ChronicleDetailLevel[] = [
  'full',
  'balanced',
  'lean',
];

export const DEFAULT_CHRONICLE_DETAIL: ChronicleDetailLevel = 'balanced';

export function isChronicleDetailLevel(value: unknown): value is ChronicleDetailLevel {
  return (
    typeof value === 'string' && (CHRONICLE_DETAIL_LEVELS as readonly string[]).includes(value)
  );
}

/** Read `chronicle.detail` off a loaded config, falling back to the default. */
export function resolveChronicleDetail(config: unknown): ChronicleDetailLevel {
  const chronicle = (config as { chronicle?: { detail?: unknown } } | undefined)?.chronicle;
  return isChronicleDetailLevel(chronicle?.detail) ? chronicle.detail : DEFAULT_CHRONICLE_DETAIL;
}

/**
 * What to do with one event.
 *
 * `count` names the aggregate it folds into; events sharing that name, a
 * session and a window become one `metrics.counter` row. The name deliberately
 * omits the dimension that made the raw rows redundant in the first place -- a
 * folded `permission.evaluated` counts per tool, not per input hash.
 */
export type ChronicleRouting = { keep: true } | { keep: false; count: string };

const KEEP: ChronicleRouting = { keep: true };

/**
 * Decide an event's fate from its type and attributes alone.
 *
 * Pure and synchronous: this runs on the append path for every event, so it
 * allocates nothing in the common case and consults nothing but its arguments.
 */
export function routeChronicleEvent(
  event: ChronicleEventInput,
  level: ChronicleDetailLevel,
): ChronicleRouting {
  if (level === 'full') return KEEP;
  // Never fold something that went wrong. A failure is rare by definition, so
  // keeping it costs nothing, and it is the row an operator actually opens.
  if (event.outcome === 'failure' || event.outcome === 'denied' || event.outcome === 'cancelled') {
    return KEEP;
  }
  const attributes = event.attributes;
  switch (event.eventType) {
    case 'permission.evaluated': {
      // A decision deserves a row when something actually decided: an operator
      // prompt, a denial, a capability the policy took away, a boundary that
      // did not simply allow. Blanket auto-approval is not a decision.
      const routine =
        attributes?.effectiveDecision === 'auto' &&
        attributes.policyDecision === 'auto' &&
        attributes.capabilityDowngraded !== true &&
        (attributes.boundaryDecision === undefined || attributes.boundaryDecision === 'allow');
      return routine ? { keep: false, count: 'permission.auto' } : KEEP;
    }
    case 'iteration.started':
    case 'iteration.completed':
      // The payload is an index into a sequence the counter already counts.
      return { keep: false, count: event.eventType };
    case 'token.accounted':
    case 'subagent.token_accounted':
      // Cumulative and latest-wins: the aggregate carries the running totals,
      // which is the only thing any reader has ever taken from these.
      return { keep: false, count: event.eventType };
    default:
      break;
  }
  if (level !== 'lean') return KEEP;
  switch (event.eventType) {
    case 'tool.started':
      // `tool.executed` repeats the tool name, carries the duration and is
      // emitted for the same call. The only loss is the input preview of calls
      // that succeeded -- and a failing call still keeps both rows, because the
      // outcome check above returns early.
      return { keep: false, count: 'tool.started' };
    case 'file.external.modified':
      return { keep: false, count: 'file.external.modified' };
    default:
      return KEEP;
  }
}
