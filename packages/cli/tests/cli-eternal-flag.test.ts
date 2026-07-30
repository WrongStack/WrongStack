import { TOKENS } from '@wrongstack/core/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  goalFilePath: vi.fn((root: string) => `${root}/goal.json`),
  loadGoal: vi.fn(),
  saveGoal: vi.fn(),
  emptyGoal: vi.fn((goal: string) => ({
    goal,
    journal: [],
    setAt: 'empty-set-at',
    lastActivityAt: 'empty-last-activity',
  })),
  engineOptions: [] as unknown[],
  engineInstances: [] as Array<{ prime: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@wrongstack/core/goal', () => ({
  goalFilePath: mocks.goalFilePath,
  loadGoal: mocks.loadGoal,
  saveGoal: mocks.saveGoal,
  emptyGoal: mocks.emptyGoal,
}));

vi.mock('@wrongstack/core/execution', () => ({
  EternalAutonomyEngine: class {
    prime = vi.fn().mockResolvedValue(undefined);

    constructor(options: unknown) {
      mocks.engineOptions.push(options);
      mocks.engineInstances.push(this);
    }
  },
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    color: {
      red: (value: string) => value,
      dim: (value: string) => value,
    },
  };
});

import { launchEternalFromFlag } from '../src/cli-eternal-flag.js';

function dependencies(options?: {
  mission?: string;
  effectiveMaxContext?: number;
  prior?: unknown;
  brain?: unknown;
  setYolo?: (on: boolean) => void;
  logger?: { warn(message: string): void };
  withEngineRef?: boolean;
}) {
  const permissionPolicy = { setYolo: options?.setYolo };
  const compactor = { compact: vi.fn() };
  const resolve = vi.fn((token: unknown) => {
    if (token === TOKENS.PermissionPolicy) return permissionPolicy;
    if (token === TOKENS.Compactor) return compactor;
    if (token === TOKENS.BrainArbiter) {
      if (options && 'brain' in options) return options.brain;
      throw new Error('brain not bound');
    }
    throw new Error('unknown token');
  });
  const engineRef = options?.withEngineRef ? { current: undefined } : undefined;
  mocks.loadGoal.mockResolvedValue(options?.prior ?? null);
  const deps = {
    eternalFlag: options?.mission ?? 'Ship safely',
    projectRoot: 'C:/repo',
    agent: { id: 'agent' },
    container: { resolve },
    renderer: { write: vi.fn() },
    broadcastEternalIteration: vi.fn(),
    effectiveMaxContext: options?.effectiveMaxContext ?? 8_000,
    configRef: { current: { provider: 'provider', model: 'model', yolo: false } },
    autonomyModeRef: { current: 'off' },
    eternalEngineRef: engineRef,
    logger: options?.logger,
  };
  return { deps, resolve, permissionPolicy, compactor, engineRef };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engineOptions.length = 0;
  mocks.engineInstances.length = 0;
});

describe('launchEternalFromFlag', () => {
  it('is a no-op for an empty mission', async () => {
    const { deps, resolve } = dependencies({ mission: '' });

    await expect(launchEternalFromFlag(deps as never)).resolves.toBe(false);
    expect(mocks.loadGoal).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('creates a fresh goal, enables YOLO, and launches without an optional brain', async () => {
    const setYolo = vi.fn();
    const { deps, engineRef } = dependencies({ setYolo, withEngineRef: true });

    await expect(launchEternalFromFlag(deps as never)).resolves.toBe(true);

    expect(mocks.goalFilePath).toHaveBeenCalledWith('C:/repo');
    expect(mocks.emptyGoal).toHaveBeenCalledWith('Ship safely');
    expect(mocks.saveGoal).toHaveBeenCalledWith('C:/repo/goal.json', {
      goal: 'Ship safely',
      journal: [],
      setAt: 'empty-set-at',
      lastActivityAt: 'empty-last-activity',
    });
    expect(setYolo).toHaveBeenCalledWith(true);
    expect(deps.configRef.current.yolo).toBe(true);
    expect(mocks.engineOptions).toEqual([
      expect.objectContaining({
        agent: deps.agent,
        compactor: expect.any(Object),
        maxContextTokens: 8_000,
        brain: undefined,
        logger: undefined,
      }),
    ]);
    expect(mocks.engineInstances[0]?.prime).toHaveBeenCalledOnce();
    expect(engineRef?.current).toBe(mocks.engineInstances[0]);
    expect(deps.autonomyModeRef.current).toBe('eternal');
    expect(deps.renderer.write).toHaveBeenCalledWith(
      'Eternal mode launching from --eternal flag. Goal: Ship safely\n',
    );
  });

  it('preserves an existing journal, logger warnings, and an optional brain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    const warn = vi.fn();
    const prior = {
      goal: 'old goal',
      journal: [{ iteration: 1 }],
      setAt: 'old-set-at',
      lastActivityAt: 'old-activity',
      extra: 'preserved',
    };
    const mission = 'x'.repeat(81);
    const brain = { decide: vi.fn() };
    const { deps } = dependencies({
      mission,
      effectiveMaxContext: 0,
      prior,
      brain,
      logger: { warn },
    });
    mocks.loadGoal.mockImplementation(
      async (_path: string, _fallback: unknown, onWarning?: (message: string) => void) => {
        onWarning?.('goal warning');
        return prior;
      },
    );

    await launchEternalFromFlag(deps as never);

    expect(warn).toHaveBeenCalledWith('goal warning');
    expect(mocks.saveGoal).toHaveBeenCalledWith(
      'C:/repo/goal.json',
      expect.objectContaining({
        goal: mission,
        journal: prior.journal,
        extra: 'preserved',
        setAt: '2026-07-30T12:00:00.000Z',
        lastActivityAt: '2026-07-30T12:00:00.000Z',
      }),
    );
    expect(mocks.engineOptions[0]).toEqual(
      expect.objectContaining({
        maxContextTokens: undefined,
        brain,
        logger: deps.logger,
      }),
    );
    expect(deps.renderer.write).toHaveBeenCalledWith(
      `Eternal mode launching from --eternal flag. Goal: ${'x'.repeat(80)}…\n`,
    );
    vi.useRealTimers();
  });

  it('supports permission policies without a YOLO setter', async () => {
    const { deps } = dependencies({ brain: undefined });
    await expect(launchEternalFromFlag(deps as never)).resolves.toBe(true);
  });
});
