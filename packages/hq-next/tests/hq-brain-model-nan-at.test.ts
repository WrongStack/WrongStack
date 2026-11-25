import type { HqEventEnvelope } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { buildTrail } from '../src/features/brain/model';

describe('buildTrail (F2204)', () => {
  it('sanitizes non-finite event timestamps so sorting and lastAt remain finite', () => {
    const trail = buildTrail([
      {
        id: 'e2',
        clientId: 'c1',
        projectId: 'p1',
        sessionId: 's1',
        type: 'brain.event',
        payload: { kind: 'decision_requested', requestId: 'r1', at: 200, question: 'q' },
      } as unknown as HqEventEnvelope,
      {
        id: 'enan',
        clientId: 'c1',
        projectId: 'p1',
        sessionId: 's1',
        type: 'brain.event',
        payload: { kind: 'decision_requested', requestId: 'rnan', at: Number.NaN, question: 'nan' },
      } as unknown as HqEventEnvelope,
      {
        id: 'e1',
        clientId: 'c1',
        projectId: 'p1',
        sessionId: 's1',
        type: 'brain.event',
        payload: { kind: 'decision_requested', requestId: 'r2', at: 100, question: 'q2' },
      } as unknown as HqEventEnvelope,
    ]);
    expect(trail.map((i) => (i.kind === 'decision' ? i.requestId : i.key))).toEqual([
      'r1',
      'r2',
      'rnan',
    ]);
    expect(trail.every((i) => Number.isFinite(i.lastAt))).toBe(true);
  });
});
