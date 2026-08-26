import { describe, expect, it } from 'vitest';
import { FleetBus, FleetUsageAggregator } from '../../src/coordination/fleet-bus.js';

/**
 * `FleetUsage.total` is the run total, and retirement must not un-spend.
 *
 * `removeSubagent` used to subtract a retired worker's contribution from
 * `total` — bounding the per-agent map (its stated purpose) but also making the
 * headline figure mean "currently-live subagents" while every reader treated it
 * as the run total: the director budgets against it, and it is what lands in
 * `director-state.json` / `fleet.json`. An orchestration that retires workers as
 * it completes them therefore watched its own reported spend shrink as it made
 * progress. The map is still bounded; the spend now moves to `retired`.
 */
describe('fleet usage aggregation across retirement', () => {
  const response = (bus: FleetBus, subagentId: string, input: number, output: number): void => {
    bus.emit({
      type: 'provider.response',
      subagentId,
      payload: { usage: { input, output, cacheRead: input * 2, cacheWrite: 0 } },
    } as never);
  };

  it('keeps retired spend in the total and reports it separately', () => {
    const bus = new FleetBus();
    const usage = new FleetUsageAggregator(bus);

    response(bus, 'worker-a', 100, 10);
    response(bus, 'worker-b', 200, 20);
    expect(usage.snapshot().total).toMatchObject({ input: 300, output: 30, cacheRead: 600 });

    usage.removeSubagent('worker-a');
    const after = usage.snapshot();

    // The run total is unchanged — worker-a's tokens were really spent.
    expect(after.total).toMatchObject({ input: 300, output: 30, cacheRead: 600 });
    // The per-agent map is still bounded: the retired entry is gone.
    expect(Object.keys(after.perSubagent)).toEqual(['worker-b']);
    // And its contribution is accounted for, not merely absorbed.
    expect(after.retired).toMatchObject({ subagents: 1, input: 100, output: 10, cacheRead: 200 });

    // `total - retired` reproduces the live-only figure the old behavior gave,
    // so a consumer that genuinely wants "currently live" is not stranded.
    expect(after.total.input - after.retired.input).toBe(200);

    usage.dispose();
  });

  it('accumulates across repeated retirements without drifting negative', () => {
    const bus = new FleetBus();
    const usage = new FleetUsageAggregator(bus);

    for (let i = 0; i < 5; i++) {
      response(bus, `worker-${i}`, 100, 10);
      usage.removeSubagent(`worker-${i}`);
    }

    const snapshot = usage.snapshot();
    expect(snapshot.total).toMatchObject({ input: 500, output: 50 });
    expect(snapshot.retired.subagents).toBe(5);
    expect(Object.keys(snapshot.perSubagent)).toEqual([]);
    usage.dispose();
  });

  it('ignores a retire call for an unknown subagent', () => {
    const bus = new FleetBus();
    const usage = new FleetUsageAggregator(bus);
    response(bus, 'worker-a', 100, 10);

    usage.removeSubagent('never-existed');

    const snapshot = usage.snapshot();
    expect(snapshot.total).toMatchObject({ input: 100, output: 10 });
    expect(snapshot.retired.subagents).toBe(0);
    usage.dispose();
  });
});
