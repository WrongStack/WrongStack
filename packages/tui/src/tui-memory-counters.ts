/**
 * Allocation-neutral cumulative counters for correlating TUI activity with
 * process memory samples. Keep this module payload-free: counters must never
 * retain provider text, tool outputs, actions or React state.
 */
interface TuiMemoryCounters {
  appRenders: number;
  providerTextDeltaEvents: number;
  providerTextDeltaChars: number;
  providerThinkingDeltaEvents: number;
  providerThinkingDeltaChars: number;
  providerResponses: number;
  toolProgressEvents: number;
  toolProgressChars: number;
  toolExecutedEvents: number;
  toolOutputBytes: number;
  streamFlushes: number;
  historyRetainedEntries: number;
  historyGroupedEntries: number;
  historyMountedGroups: number;
  historyMountedEntries: number;
  historyCachedGroups: number;
  historyMeasuredGroups: number;
  historyViewportRows: number;
  historyTotalRows: number;
}

const counters: TuiMemoryCounters = {
  appRenders: 0,
  providerTextDeltaEvents: 0,
  providerTextDeltaChars: 0,
  providerThinkingDeltaEvents: 0,
  providerThinkingDeltaChars: 0,
  providerResponses: 0,
  toolProgressEvents: 0,
  toolProgressChars: 0,
  toolExecutedEvents: 0,
  toolOutputBytes: 0,
  streamFlushes: 0,
  historyRetainedEntries: 0,
  historyGroupedEntries: 0,
  historyMountedGroups: 0,
  historyMountedEntries: 0,
  historyCachedGroups: 0,
  historyMeasuredGroups: 0,
  historyViewportRows: 0,
  historyTotalRows: 0,
};

function add<K extends keyof TuiMemoryCounters>(key: K, amount = 1): void {
  counters[key] += Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function recordTuiAppRender(): void {
  add('appRenders');
}

export function recordProviderTextDelta(chars: number): void {
  add('providerTextDeltaEvents');
  add('providerTextDeltaChars', chars);
}

export function recordProviderThinkingDelta(chars: number): void {
  add('providerThinkingDeltaEvents');
  add('providerThinkingDeltaChars', chars);
}

export function recordProviderResponse(): void {
  add('providerResponses');
}

export function recordToolProgress(chars: number): void {
  add('toolProgressEvents');
  add('toolProgressChars', chars);
}

export function recordToolExecuted(outputBytes: number | undefined): void {
  add('toolExecutedEvents');
  add('toolOutputBytes', outputBytes ?? 0);
}

export function recordStreamFlush(): void {
  add('streamFlushes');
}

export function setTuiHistoryMemoryGauges(
  gauges: Pick<
    TuiMemoryCounters,
    | 'historyRetainedEntries'
    | 'historyGroupedEntries'
    | 'historyMountedGroups'
    | 'historyMountedEntries'
    | 'historyCachedGroups'
    | 'historyMeasuredGroups'
    | 'historyViewportRows'
    | 'historyTotalRows'
  >,
): void {
  for (const [key, value] of Object.entries(gauges) as Array<[keyof typeof gauges, number]>) {
    counters[key] = Number.isFinite(value) ? Math.max(0, value) : 0;
  }
}

export function snapshotTuiMemoryCounters(): Readonly<TuiMemoryCounters> {
  return { ...counters };
}

/** Test-only reset. Production counters are lifetime-monotonic. */
export function resetTuiMemoryCounters(): void {
  for (const key of Object.keys(counters) as Array<keyof TuiMemoryCounters>) counters[key] = 0;
}
