import type { Config, SessionWriter } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDirectorAndAutonomy } from '../src/wiring/director-setup.js';

const mocks = vi.hoisted(() => ({
  createAgentMonitorService: vi.fn().mockReturnValue({ monitor: true }),
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  return { ...actual, createAgentMonitorService: mocks.createAgentMonitorService };
});

const priorConcurrent = process.env['WRONGSTACK_MAX_CONCURRENT'];
const priorManifest = process.env['WRONGSTACK_FLEET_MANIFEST'];
const priorMaxSpawns = process.env['WRONGSTACK_MAX_SPAWNS'];

afterEach(() => {
  if (priorConcurrent === undefined) delete process.env['WRONGSTACK_MAX_CONCURRENT'];
  else process.env['WRONGSTACK_MAX_CONCURRENT'] = priorConcurrent;
  if (priorManifest === undefined) delete process.env['WRONGSTACK_FLEET_MANIFEST'];
  else process.env['WRONGSTACK_FLEET_MANIFEST'] = priorManifest;
  if (priorMaxSpawns === undefined) delete process.env['WRONGSTACK_MAX_SPAWNS'];
  else process.env['WRONGSTACK_MAX_SPAWNS'] = priorMaxSpawns;
  vi.clearAllMocks();
});

function setup(flags: Record<string, string | boolean>, config: Config) {
  const autonomyModeRef = { current: 'off' as const };
  const result = setupDirectorAndAutonomy({
    flags,
    config,
    wpaths: { projectSessions: 'D:/repo/.wrongstack/sessions' } as never,
    session: { id: 'session-1' } as SessionWriter,
    events: {} as never,
    autonomyModeRef,
  });
  return { result, autonomyModeRef };
}

describe('setupDirectorAndAutonomy', () => {
  it('prefers CLI concurrency and autonomy flags and creates session-scoped paths', () => {
    process.env['WRONGSTACK_MAX_CONCURRENT'] = '8';
    process.env['WRONGSTACK_FLEET_MANIFEST'] = 'D:/custom/fleet.json';
    const { result, autonomyModeRef } = setup(
      { 'max-concurrent': '6', autonomy: 'eternal-parallel' },
      { maxConcurrent: 4, nextPrediction: true } as Config,
    );

    expect(result.directorMode).toBe(true);
    expect(result.maxConcurrent).toBe(6);
    expect(result.maxConcurrentSource).toBe('cli-flag');
    expect(result.maxSpawns).toBe(64);
    expect(result.maxSpawnsSource).toBe('default');
    expect(result.autonomyMode).toBe('eternal-parallel');
    expect(autonomyModeRef.current).toBe('eternal-parallel');
    expect(result.nextPredictEnabled).toBe(true);
    expect(result.manifestPath).toBe('D:/custom/fleet.json');
    expect(result.sharedScratchpadPath).toContain('shared');
    expect(result.subagentSessionsRoot).toContain('subagents');
    expect(result.stateCheckpointPath).toContain('director-state.json');
    expect(mocks.createAgentMonitorService).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', maxEntriesPerAgent: 500 }),
    );
  });

  it('falls back from invalid flag to environment, config, then defaults', () => {
    process.env['WRONGSTACK_MAX_CONCURRENT'] = '5';
    expect(
      setup({ 'max-concurrent': 'invalid' }, { maxConcurrent: 4 } as Config).result.maxConcurrent,
    ).toBe(5);

    delete process.env['WRONGSTACK_MAX_CONCURRENT'];
    expect(setup({}, { maxConcurrent: 4 } as Config).result.maxConcurrent).toBe(4);
    expect(setup({}, { maxConcurrent: 0 } as Config).result.maxConcurrent).toBeUndefined();
    expect(setup({}, { autonomy: { defaultMode: 'suggest' } } as Config).result.autonomyMode).toBe(
      'suggest',
    );
  });

  it('resolves maxSpawns from env/profile with source labels', () => {
    process.env['WRONGSTACK_MAX_SPAWNS'] = '256';
    const fromEnv = setup({}, { fleet: { budget: { maxSpawns: 96 } } } as Config).result;
    expect(fromEnv.maxSpawns).toBe(256);
    expect(fromEnv.maxSpawnsSource).toBe('env');
    delete process.env['WRONGSTACK_MAX_SPAWNS'];

    const fromProfile = setup({}, { fleet: { budget: { maxSpawns: 96 } } } as Config).result;
    expect(fromProfile.maxSpawns).toBe(96);
    expect(fromProfile.maxSpawnsSource).toBe('profile');
  });

  it('broadcasts to healthy listeners even when another listener throws', () => {
    const { result } = setup({}, {} as Config);
    const eternal = vi.fn();
    const stage = vi.fn();
    result.eternalListeners.add(() => {
      throw new Error('listener failed');
    });
    result.eternalListeners.add(eternal);
    result.stageListeners.add(() => {
      throw new Error('listener failed');
    });
    result.stageListeners.add(stage);

    result.broadcastEternalIteration({ iteration: 1 } as never);
    result.broadcastAutonomyStage({ stage: 'decide' } as never);
    expect(eternal).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledOnce();
  });
});
