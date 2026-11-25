import { describe, expect, it } from 'vitest';
import { type FleetAgentState, renderFleetLine } from '../src/fleet-statusline.js';

describe('renderFleetLine non-finite clock and columns guard', () => {
  it('renders 0s instead of NaNhNaNm when now or columns is NaN', () => {
    const states = new Map<string, FleetAgentState>([
      [
        'a1',
        {
          id: 'a1',
          name: 'worker-alpha',
          status: 'running',
          iterations: 2,
          toolCalls: 5,
          startedAt: 1000,
        },
      ],
    ]);

    const line = renderFleetLine(states, Number.NaN, Number.NaN);
    expect(line).not.toContain('NaN');
    expect(line).toContain('0s');
  });
});
