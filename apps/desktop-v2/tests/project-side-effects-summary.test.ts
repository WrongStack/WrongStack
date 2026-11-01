import { expect, it } from 'vitest';
import { readSideEffectsSummary } from '../src/ProjectSideEffectsSummary';

it('reads the project side-effect summary and orders counts', () => {
  const read = readSideEffectsSummary({
    sessionsScanned: 3,
    total: 3,
    sessionsWithEffects: 2,
    byRisk: { network: 1, shell: 2, bad: -1 },
    byTool: { bash: 2 },
    records: [
      { sessionId: 's', ts: '2026-11-01T00:00:00Z', toolName: 'bash', risk: 'shell', input: '{}' },
      { ts: 'x' },
    ],
  });
  expect(read?.byRisk).toEqual([
    ['shell', 2],
    ['network', 1],
  ]);
  expect(read?.records).toHaveLength(1);
  expect(read?.records[0]?.sessionTitle).toBe('s');
  expect(readSideEffectsSummary({})).toBeNull();
});
