import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { healingBusy, serviceHealing } from '../src/service-healing';

const frame = (id: string, phase: string, at: number) => ({
  type: 'connections.auto_heal_status',
  payload: { serviceId: id, phase, at, message: phase, attempt: 1 },
});
describe('service auto-heal feedback', () => {
  it('retains each service, rejects older events, and clears a finished restart', () => {
    let state = reduceEngine(emptyEngineState, frame('index', 'restarting', 100));
    state = reduceEngine(state, frame('memory', 'refused', 101));
    expect(healingBusy(state.serviceHealing['index'], 102)).toBe(true);
    expect(state.serviceHealing['memory']?.phase).toBe('refused');
    state = reduceEngine(state, frame('index', 'restarted', 110));
    state = reduceEngine(state, frame('index', 'restarting', 100));
    expect(state.serviceHealing['index']?.phase).toBe('restarted');
    expect(healingBusy(state.serviceHealing['index'], 111)).toBe(false);
  });
  it('rejects a phase that is not one of the healing strings', () => {
    expect(serviceHealing({ phase: ['restarting'], at: 10, message: 'up', attempt: 1 })).toBeNull();
    expect(serviceHealing({ phase: 'restarting', at: 10, message: 'up', attempt: 1 })?.phase).toBe(
      'restarting',
    );
  });
  it('does not leave a stale restart blocking manual controls forever', () => {
    const state = reduceEngine(emptyEngineState, frame('index', 'restarting', 100));
    expect(healingBusy(state.serviceHealing['index'], 120100)).toBe(false);
    expect(reduceEngine(emptyEngineState, frame('index', 'invented', 100)).serviceHealing).toEqual(
      {},
    );
  });
});
