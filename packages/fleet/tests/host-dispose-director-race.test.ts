import { describe, expect, it } from 'vitest';
import { MultiAgentHost } from '../src/host.js';
import { buildDirector } from '../src/host-director-setup.js';

describe('MultiAgentHost dispose vs buildDirector race', () => {
  it('waits for in-flight buildDirector and does not arm coordinator or shadowManager after dispose', async () => {
    let resolveRunner!: (r: unknown) => void;
    let armedAfterDispose = false;
    let setRunnerAfterDispose = false;

    const host = Object.create(MultiAgentHost.prototype) as MultiAgentHost &
      Record<string, unknown>;
    Object.assign(host, {
      deps: {
        configStore: {
          get: () => ({
            provider: 'openai',
            model: 'gpt-4o',
            fleet: {
              exploreCompanion: { enabled: false },
              memoryCompanion: { enabled: false },
              skillCompanion: { enabled: false },
            },
            exploreCompanion: { enabled: false },
          }),
        },
        container: { safeResolve: () => undefined },
        providerRegistry: { has: () => true, create: () => ({}) },
        events: { on: () => () => {}, emit: () => {} },
        session: { id: 'boot' },
        projectRoot: process.cwd(),
      },
      opts: {},
      director: undefined,
      buildingDirector: null,
      directorRunnerSet: false,
      disposed: false,
      directorOffHandles: [],
      coordinatorOffHandle: null,
      statusBroadcaster: null,
      fleetSupervisor: null,
      exploreCompanionOff: null,
      exploreCompanions: null,
      memoryCompanion: null,
      skillCompanion: null,
      adaptiveConcurrencyController: undefined,
      fleetManager: undefined,
      learningScheduler: { dispose: () => {}, sweep: () => {} },
      shadowManager: {
        dispose: () => {},
        armIfNeeded: () => {
          armedAfterDispose = true;
        },
      },
      getCoordinator: () => ({
        on: () => () => {},
        off: () => {},
        setRunner: () => {
          setRunnerAfterDispose = true;
        },
        setMaxConcurrent: () => {},
      }),
      buildSubagentRunner: () =>
        new Promise((res) => {
          resolveRunner = res;
        }),
      getMaxConcurrent: () => 2,
    });

    const buildP = buildDirector(host as never);
    host.buildingDirector = buildP as never;
    for (let i = 0; i < 20 && !resolveRunner; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(resolveRunner).toBeDefined();

    const disposeP = MultiAgentHost.prototype.dispose.call(host);
    await Promise.resolve();
    resolveRunner({});
    await Promise.all([disposeP, buildP]);

    expect(host.disposed).toBe(true);
    expect(armedAfterDispose).toBe(false);
    expect(setRunnerAfterDispose).toBe(false);
    expect(await MultiAgentHost.prototype.ensureDirector.call(host)).toBeNull();
  });
});
