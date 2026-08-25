import type { ChronicleJournalStats } from './journal.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

/**
 * Minimal append surface consumed by Chronicle event adapters.
 *
 * Adapters can target either the in-process journal or the project server
 * without changing event mapping, correlation, or secret scrubbing.
 */
export interface ChronicleEventSink {
  append(input: ChronicleEventInput): Promise<ChronicleEvent>;
  /**
   * Append many events as ONE unit of work. Optional: adapters that emit a
   * single event per call have nothing to gain, and leaving it optional keeps
   * every existing sink (and test double) valid without a shim.
   *
   * The SQLite journal wraps each append in `BEGIN IMMEDIATE` and, at
   * `synchronous = FULL`, fsyncs on commit. Callers that produce a burst —
   * the file observer reconciling a branch switch, say — turn N transactions
   * and N fsyncs into one by routing through here. SQLite's binding is
   * synchronous, so `Promise.all` over N `append()` calls does NOT overlap
   * them; batching is the only thing that actually helps.
   */
  appendBatch?(inputs: readonly ChronicleEventInput[]): Promise<ChronicleEvent[]>;
  flush(): Promise<void>;
  stats(): ChronicleJournalStats;
}
