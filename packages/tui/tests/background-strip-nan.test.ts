import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app-state-fleet.js';
import { buildBackgroundItems, layoutStripChips } from '../src/background-strip-model.js';

describe('background-strip-model NaN guards (F1994)', () => {
  it('keeps oldest-first sort stable with NaN startedAt and bounds NaN width', () => {
    const items = buildBackgroundItems(
      {
        late: { id: 'late', name: 'Late', status: 'running', startedAt: 200 } as FleetEntry,
        bad: { id: 'bad', name: 'Bad', status: 'running', startedAt: Number.NaN } as FleetEntry,
        early: { id: 'early', name: 'Early', status: 'running', startedAt: 100 } as FleetEntry,
      },
      [],
    );
    expect(items[0]?.agentId).toBe('early');
    expect(items[1]?.agentId).toBe('late');
    expect(layoutStripChips(items, 0, Number.NaN, 300, '*').chips).toHaveLength(1);
  });
});
