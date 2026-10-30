import type { EngineEvent } from './engine-state';

/** "read ×3 · edit" style summary of a turn's completed tool calls, in first-use order. */
export function turnToolSummary(events: readonly EngineEvent[]): {
  calls: number;
  failed: number;
  text: string;
} {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const event of events) {
    if (event.type !== 'tool.executed') continue;
    const name = typeof event.payload['name'] === 'string' ? event.payload['name'] : 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (event.payload['ok'] === false) failed += 1;
  }
  const calls = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return {
    calls,
    failed,
    text: [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · '),
  };
}
