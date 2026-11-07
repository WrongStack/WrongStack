import { afterEach, describe, expect, it } from 'vitest';
import { Director } from '../src/director.js';
import { FleetManager } from '../src/fleet-manager.js';

describe('Director resolved worker pricing', () => {
  const directors: Director[] = [];
  afterEach(async () => {
    await Promise.all(directors.splice(0).map((director) => director.shutdown()));
  });

  it('looks up the matrix target and preserves zero-priced explicit rates', async () => {
    const lookedUp: string[] = [];
    const director = new Director({
      sessionId: 'sess_pricing_matrix',
      config: {
        coordinatorId: 'pricing-matrix',
        maxConcurrent: 2,
        doneCondition: { type: 'all_tasks_done' },
      },
      sessionProvider: 'leader-provider',
      sessionModel: 'leader-model',
      modelMatrix: { '*': { provider: 'routed-provider', model: 'routed-model' } },
      resolveModelPrice: async (provider, model) => {
        lookedUp.push(provider + '/' + model);
        return { input: 1, output: 2 };
      },
    });
    directors.push(director);
    await director.spawn({ name: 'routed' });
    const free = await director.spawn({ name: 'free' }, { input: 0, output: 0 });
    director.fleet.emit({
      subagentId: free,
      type: 'provider.response',
      ts: Date.now(),
      payload: { usage: { input: 100, output: 5 } },
    });
    expect(lookedUp).toEqual(['routed-provider/routed-model']);
    expect(director.snapshot().perSubagent[free]?.cost).toBe(0);
  });

  for (const managed of [false, true]) {
    it(`prices the resolved worker with${managed ? '' : 'out'} a fleet manager`, async () => {
      const lookedUp: string[] = [];
      const director = new Director({
        sessionId: 'sess_worker_pricing',
        config: {
          coordinatorId: 'pricing',
          maxConcurrent: 2,
          doneCondition: { type: 'all_tasks_done' },
        },
        ...(managed ? { fleetManager: new FleetManager({ maxSpawns: 10 }) } : {}),
        sessionProvider: 'catalog-provider',
        sessionModel: 'worker-model',
        resolveModelPrice: async (provider, model) => {
          lookedUp.push(provider + '/' + model);
          return { input: 1, output: 2 };
        },
      });
      directors.push(director);
      // An explicit caller-supplied rate is the unaffected control.
      const control = await director.spawn(
        { name: 'control', provider: 'catalog-provider', model: 'control-model' },
        { input: 3, output: 4 },
      );
      const worker = await director.spawn({ name: 'worker' });
      const emitUsage = (id: string) =>
        director.fleet.emit({
          subagentId: id,
          type: 'provider.response',
          ts: Date.now(),
          payload: { usage: { input: 100, output: 5 } },
        });
      emitUsage(control);
      emitUsage(worker);
      expect(director.snapshot().perSubagent[control]?.cost).toBeCloseTo(0.00032, 12);
      expect(director.snapshot().perSubagent[worker]?.cost).toBeCloseTo(0.00011, 12);
      expect(lookedUp).toEqual(['catalog-provider/worker-model']);
      emitUsage(worker);
      expect(director.snapshot().perSubagent[worker]?.cost).toBeCloseTo(0.00022, 12);
    });
  }
});
