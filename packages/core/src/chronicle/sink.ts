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
  flush(): Promise<void>;
  stats(): ChronicleJournalStats;
}
