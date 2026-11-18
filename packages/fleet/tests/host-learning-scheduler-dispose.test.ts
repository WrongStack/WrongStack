import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostLearningScheduler } from '../src/host-learning-scheduler.js';
import type { MultiAgentDeps } from '../src/host-types.js';

const { buildProviderMock } = vi.hoisted(() => ({
  buildProviderMock: vi.fn(),
}));

vi.mock('../src/host-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host-provider.js')>();
  return {
    ...actual,
    buildHostSubagentProvider: buildProviderMock,
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('HostLearningScheduler dispose ownership', () => {
  const tempDirs: string[] = [];

  function makeTempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-learning-dispose-'));
    tempDirs.push(dir);
    return dir;
  }

  function makeDeps(projectRoot: string): MultiAgentDeps {
    return {
      projectRoot,
      cwd: projectRoot,
      events: new EventBus(),
      session: { id: 'sess-dispose-test' } as never,
      configStore: {
        get: () => ({
          provider: 'fake',
          model: 'fake-model',
          fleet: {
            learning: {
              autoOptimize: {
                enabled: true,
                debounceMs: 60_000,
              },
            },
          },
        }),
      } as never,
      container: { safeResolve: () => undefined } as never,
      fallbackProfileManager: {} as never,
      toolRegistry: {} as never,
      providerRegistry: {} as never,
      systemPromptBuilder: {} as never,
      tokenCounter: {} as never,
      secretScrubber: { scrub: (s: string) => s } as never,
    };
  }

  afterEach(() => {
    buildProviderMock.mockReset();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not allocate a new LearningOptimizationScheduler when notifyCaptured or sweep runs after dispose', () => {
    const scheduler = new HostLearningScheduler(makeDeps(makeTempRoot()));
    expect(scheduler.getOptimizer()).not.toBeNull();

    scheduler.dispose();
    scheduler.notifyCaptured('coder');
    scheduler.sweep();

    expect(scheduler.getOptimizer()).toBeNull();
  });

  it('drops in-flight resolveOptimizerLlm and classifyDispatch completions gated after dispose', async () => {
    const entered = deferred<void>();
    const gate = deferred<{ id: string }>();
    buildProviderMock.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const scheduler = new HostLearningScheduler(makeDeps(makeTempRoot()));
    const pendingLlm = scheduler.resolveOptimizerLlm();
    await entered.promise;

    scheduler.dispose();
    gate.resolve({ id: 'fake-provider' });

    await expect(pendingLlm).resolves.toBeUndefined();
    await expect(
      scheduler.classifyDispatch('inspect module', [
        { role: 'explorer', name: 'Explorer', summary: 'Reads files' },
      ]),
    ).resolves.toBeNull();
  });
});
