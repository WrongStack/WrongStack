/**
 * Sink decorator that folds low-information events into periodic counters.
 *
 * Every Chronicle adapter writes through a {@link ChronicleEventSink}, so one
 * decorator here applies the collection policy to all of them without any
 * adapter knowing it exists. The alternative was the same suppression logic
 * copied into `tool-adapter`, `domain-adapter` and every future adapter, each
 * free to drift from the others.
 *
 * A folded event does not disappear; it joins a bucket keyed by (counter name,
 * session, agent, dimension) and is emitted as one `metrics.counter` event when
 * the window closes. The aggregate keeps the occurrence counts and, for the
 * numeric attributes worth carrying, their sums and latest values -- enough to
 * answer "how many tool calls", "how many auto-approvals", "what are the token
 * totals" without storing one 1.3 KB row per occurrence.
 *
 * Windows are age-based, not idle-based: these events arrive continuously for
 * as long as a session is alive, so an idle rule would either never fire or
 * fire once per event, which is the behaviour being removed.
 */
import {
  type ChronicleDetailLevel,
  type ChronicleRouting,
  routeChronicleEvent,
} from './detail-policy.js';
import type { ChronicleJournalStats } from './journal.js';
import type { ChronicleEventSink } from './sink.js';
import {
  CHRONICLE_SCHEMA_VERSION,
  type ChronicleEvent,
  type ChronicleEventInput,
} from './types.js';

export interface ChronicleCounterSinkOptions {
  inner: ChronicleEventSink;
  level: ChronicleDetailLevel;
  /** Aggregation window. Defaults to {@link DEFAULT_COUNTER_WINDOW_MS}. */
  windowMs?: number | undefined;
  now?: (() => number) | undefined;
}

/**
 * Two minutes, matching the rollup adapter's gauge window.
 *
 * Long enough that a busy session folds hundreds of events into one row, short
 * enough that a crash costs at most one window of counts -- and counts are the
 * one thing here that is reconstructible from the session log anyway.
 */
export const DEFAULT_COUNTER_WINDOW_MS = 120_000;

/**
 * Numeric attributes summed into the aggregate, per event type.
 *
 * An allowlist rather than "every number found": folded events are folded
 * precisely because their attribute sets are uninteresting, and summing an
 * arbitrary field -- an index, an id that happens to be numeric -- produces a
 * number that means nothing but looks like it means something.
 */
const SUMMED_ATTRIBUTES: Record<string, readonly string[]> = {
  'token.accounted': [
    'deltaUsage.input',
    'deltaUsage.output',
    'deltaUsage.cacheRead',
    'deltaUsage.cacheWrite',
  ],
  'subagent.token_accounted': [
    'deltaUsage.input',
    'deltaUsage.output',
    'deltaUsage.cacheRead',
    'deltaUsage.cacheWrite',
  ],
};

/** Attributes whose newest value is kept verbatim, because they are cumulative. */
const LATEST_ATTRIBUTES: Record<string, readonly string[]> = {
  'token.accounted': [
    'usage.input',
    'usage.output',
    'usage.cacheRead',
    'usage.cacheWrite',
    'cost.total',
  ],
  'subagent.token_accounted': [
    'usage.input',
    'usage.output',
    'usage.cacheRead',
    'usage.cacheWrite',
  ],
};

/** The one dimension kept on the aggregate, per counter. Everything else goes. */
const COUNTER_DIMENSION: Record<string, string> = {
  'permission.auto': 'toolName',
  'tool.started': 'toolName',
};

interface CounterBucket {
  counter: string;
  sessionId: string | undefined;
  agentId: string | undefined;
  dimension: string | undefined;
  startedAt: number;
  updatedAt: number;
  samples: number;
  outcomes: Record<string, number>;
  sums: Record<string, number>;
  latest: Record<string, number>;
  scope: ChronicleEventInput['scope'];
  correlation: ChronicleEventInput['correlation'];
}

export interface ChronicleCounterSink extends ChronicleEventSink {
  /** Emit every open bucket. Call before shutdown so the last window survives. */
  drain(): Promise<void>;
  /** Stop the window timer, drain, and pass everything through from then on. */
  dispose(): Promise<void>;
}

export function createChronicleCounterSink(
  options: ChronicleCounterSinkOptions,
): ChronicleCounterSink {
  const now = options.now ?? (() => Date.now());
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_COUNTER_WINDOW_MS);
  const buckets = new Map<string, CounterBucket>();
  let disposed = false;

  const fold = (
    input: ChronicleEventInput,
    routing: Extract<ChronicleRouting, { keep: false }>,
  ): void => {
    const dimensionKey = COUNTER_DIMENSION[routing.count];
    const dimensionValue = dimensionKey ? input.attributes?.[dimensionKey] : undefined;
    const dimension = typeof dimensionValue === 'string' ? dimensionValue : undefined;
    const sessionId = input.scope.sessionId;
    const agentId = input.scope.agentId;
    // Unit separator rather than a printable delimiter: session ids and tool
    // names are free-form, and a collision here would merge two unrelated
    // counters into one row.
    const key = [routing.count, sessionId ?? '', agentId ?? '', dimension ?? ''].join('\u001f');
    let bucket = buckets.get(key);
    if (!bucket) {
      const at = now();
      bucket = {
        counter: routing.count,
        sessionId,
        agentId,
        dimension,
        startedAt: at,
        updatedAt: at,
        samples: 0,
        outcomes: {},
        sums: {},
        latest: {},
        scope: input.scope,
        correlation: input.correlation,
      };
      buckets.set(key, bucket);
    }
    bucket.samples++;
    bucket.updatedAt = now();
    // Keep the newest identity: a session's scope gains fields (agentId,
    // taskId) as work progresses, and the aggregate should carry the richest
    // one the window saw rather than whatever opened it.
    bucket.scope = input.scope;
    bucket.correlation = input.correlation;
    const outcome = input.outcome ?? 'unknown';
    bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1;
    for (const field of SUMMED_ATTRIBUTES[input.eventType] ?? []) {
      const value = readNumber(input.attributes, field);
      if (value !== undefined) bucket.sums[field] = (bucket.sums[field] ?? 0) + value;
    }
    for (const field of LATEST_ATTRIBUTES[input.eventType] ?? []) {
      const value = readNumber(input.attributes, field);
      if (value !== undefined) bucket.latest[field] = value;
    }
  };

  const toEvent = (bucket: CounterBucket): ChronicleEventInput => ({
    eventType: 'metrics.counter',
    outcome: 'success',
    occurredAt: new Date(bucket.updatedAt).toISOString(),
    scope: bucket.scope,
    correlation: bucket.correlation,
    durationNs: String(Math.max(0, bucket.updatedAt - bucket.startedAt) * 1_000_000),
    attributes: {
      counter: bucket.counter,
      windowStart: new Date(bucket.startedAt).toISOString(),
      windowEnd: new Date(bucket.updatedAt).toISOString(),
      samples: bucket.samples,
      outcomes: bucket.outcomes,
      ...(bucket.dimension ? { dimension: bucket.dimension } : {}),
      ...(Object.keys(bucket.sums).length > 0 ? { sums: bucket.sums } : {}),
      ...(Object.keys(bucket.latest).length > 0 ? { latest: bucket.latest } : {}),
    },
    tags: { collector: 'chronicle-counter' },
  });

  const emit = async (keys: readonly string[]): Promise<void> => {
    const pending: ChronicleEventInput[] = [];
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.samples === 0) continue;
      buckets.delete(key);
      pending.push(toEvent(bucket));
    }
    if (pending.length === 0) return;
    // One transaction for the whole sweep where the sink supports it. The
    // SQLite journal fsyncs on commit, and a sweep is exactly the burst that
    // `appendBatch` exists for.
    await appendMany(options.inner, pending);
  };

  const sweep = (): void => {
    const deadline = now() - windowMs;
    const due: string[] = [];
    for (const [key, bucket] of buckets) if (bucket.startedAt <= deadline) due.push(key);
    if (due.length === 0) return;
    void emit(due).catch(() => {
      // Counters are best-effort telemetry. A failed flush must not surface on
      // a timer tick; the next window simply accumulates from scratch.
    });
  };

  const timer = setInterval(sweep, windowMs);
  timer.unref?.();

  const drain = async (): Promise<void> => {
    await emit([...buckets.keys()]);
  };

  const route = (input: ChronicleEventInput): ChronicleRouting =>
    disposed ? { keep: true } : routeChronicleEvent(input, options.level);

  return {
    async append(input: ChronicleEventInput): Promise<ChronicleEvent> {
      const routing = route(input);
      if (routing.keep) return options.inner.append(input);
      fold(input, routing);
      return foldedAcknowledgement(input);
    },
    async appendBatch(inputs: readonly ChronicleEventInput[]): Promise<ChronicleEvent[]> {
      const kept: ChronicleEventInput[] = [];
      const slots: Array<ChronicleEvent | undefined> = [];
      for (const input of inputs) {
        const routing = route(input);
        if (routing.keep) {
          kept.push(input);
          slots.push(undefined);
        } else {
          fold(input, routing);
          slots.push(foldedAcknowledgement(input));
        }
      }
      const stored = kept.length === 0 ? [] : await appendMany(options.inner, kept);
      let cursor = 0;
      return slots.map((slot) => slot ?? (stored[cursor++] as ChronicleEvent));
    },
    async flush(): Promise<void> {
      await drain();
      await options.inner.flush();
    },
    stats(): ChronicleJournalStats {
      return options.inner.stats();
    },
    drain,
    async dispose(): Promise<void> {
      clearInterval(timer);
      // Stop folding first: the drain below is asynchronous, and anything that
      // arrives while it runs would otherwise join a bucket nothing will ever
      // collect. Passing it straight through reaches a journal that is, by
      // contract, still open until dispose() resolves.
      disposed = true;
      await drain();
    },
  };
}

async function appendMany(
  sink: ChronicleEventSink,
  inputs: readonly ChronicleEventInput[],
): Promise<ChronicleEvent[]> {
  if (sink.appendBatch) return sink.appendBatch(inputs);
  const events: ChronicleEvent[] = [];
  for (const input of inputs) events.push(await sink.append(input));
  return events;
}

/**
 * Acknowledgement handed back for an event that was folded rather than stored.
 *
 * Every adapter treats `append`'s result as fire-and-forget (`void
 * journal.append(...).catch(...)`), so nothing reads these fields. They exist
 * so the decorator keeps satisfying the sink interface, and the zeroed chain
 * fields make it obvious in a debugger that no row was written.
 */
function foldedAcknowledgement(input: ChronicleEventInput): ChronicleEvent {
  const at = new Date().toISOString();
  return {
    ...input,
    schemaVersion: CHRONICLE_SCHEMA_VERSION,
    eventId: 'folded',
    observedAt: at,
    persistedAt: at,
    sequence: 0,
    previousHash: '',
    hash: '',
  };
}

/** Read a dotted path (`usage.input`) as a finite number, or undefined. */
function readNumber(
  attributes: Record<string, unknown> | undefined,
  path: string,
): number | undefined {
  let cursor: unknown = attributes;
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}
