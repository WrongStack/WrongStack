import { describe, expect, it, vi } from 'vitest';
import {
  FleetContextOverflowError,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from '../../src/coordination/director/director-errors.js';
import type { DirectorFleetHost } from '../../src/coordination/fleet-spawn.js';
import { spawn } from '../../src/coordination/fleet-spawn.js';
import { InMemoryBridgeTransport } from '../../src/coordination/in-memory-transport.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

function makeHost(overrides: Partial<DirectorFleetHost> = {}): DirectorFleetHost {
  const coordinator = {
    spawn: vi.fn(async (config: SubagentConfig) => ({ subagentId: `sub-${config.name ?? 'x'}` })),
    assign: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setSubagentBridge: vi.fn(),
  };
  return {
    id: 'director-1',
    coordinator: coordinator as never,
    fleet: { emit: vi.fn() } as never,
    transport: new InMemoryBridgeTransport(),
    stateCheckpoint: { recordSpawn: vi.fn() } as never,
    workCompleteFlag: false,
    spawnCount: 0,
    maxSpawns: 10,
    maxSpawnDepth: 5,
    spawnDepth: 0,
    maxFleetCostUsd: Number.POSITIVE_INFINITY,
    maxLeaderContextLoad: 1,
    leaderContextPressure: 0,
    usage: { snapshot: vi.fn(() => ({ total: { cost: 0 } })) } as never,
    fleetManager: undefined,
    manifestEntries: new Map(),
    subagentBridges: new Map(),
    subagentMeta: new Map(),
    priceLookups: new Map(),
    usedNicknames: new Set(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    resolveMaxContext: vi.fn(() => 100_000),
    ...overrides,
  };
}

const config = (overrides: Partial<SubagentConfig> = {}): SubagentConfig => ({
  name: 'worker',
  role: 'hunter',
  provider: 'anthropic',
  model: 'claude',
  ...overrides,
});

describe('fleet spawn admission and bookkeeping', () => {
  it('refuses spawning after workComplete', async () => {
    const host = makeHost({ workCompleteFlag: true });
    await expect(spawn(host, config())).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    expect(host.coordinator.spawn).not.toHaveBeenCalled();
  });

  // Model resolution belongs to `resolveDirectorSpawnModel`, which
  // `Director.spawn` runs before reaching this function. fleet-spawn used to
  // carry a partial copy of the matrix step; that copy re-applied
  // `entry.provider` unconditionally and could clobber a provider a
  // higher-precedence layer (session model plan, caller pin) had already set.
  // Matrix behaviour itself is covered in director-model-matrix.test.ts.
  it('does not resolve models itself — the matrix never reaches the config here', async () => {
    const host = makeHost({
      modelMatrix: { hunter: { provider: 'matrix-provider', model: 'matrix-model' } } as never,
    });
    const candidate = config({ provider: 'lane-provider', model: undefined });
    await spawn(host, candidate);
    expect(candidate.provider).toBe('lane-provider');
    expect(candidate.model).toBeUndefined();
  });

  it('records inline spawn state and upgrades synthetic names', async () => {
    const host = makeHost();
    const candidate = config({ name: 'adhoc' });
    const id = await spawn(host, candidate, { input: 1, output: 2 });
    expect(candidate.name).not.toBe('adhoc');
    expect(host.spawnCount).toBe(1);
    expect(host.manifestEntries.has(id)).toBe(true);
    expect(host.subagentBridges.has(id)).toBe(true);
    expect(host.subagentMeta.get(id)).toEqual({ provider: 'anthropic', model: 'claude' });
    expect(host.priceLookups.get('anthropic/claude')).toEqual({ input: 1, output: 2 });
    expect(host.stateCheckpoint?.recordSpawn).toHaveBeenCalled();
    expect(host.appendSessionEvent).toHaveBeenCalled();
  });

  it('preserves explicit names', async () => {
    const host = makeHost();
    const candidate = config({ name: 'Reviewer', role: 'reviewer' });
    await spawn(host, candidate);
    expect(candidate.name).toBe('Reviewer');
    expect(host.usedNicknames.size).toBe(0);
  });

  it('enforces inline depth, count, cost, and context caps', async () => {
    await expect(
      spawn(makeHost({ spawnDepth: 5, maxSpawnDepth: 5 }), config()),
    ).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(
      spawn(makeHost({ spawnCount: 10, maxSpawns: 10 }), config()),
    ).rejects.toBeInstanceOf(FleetSpawnBudgetError);
    await expect(
      spawn(
        makeHost({
          maxFleetCostUsd: 5,
          usage: { snapshot: () => ({ total: { cost: 9 } }) } as never,
        }),
        config(),
      ),
    ).rejects.toBeInstanceOf(FleetCostCapError);
    await expect(
      spawn(makeHost({ maxLeaderContextLoad: 0.5, leaderContextPressure: 99_000 }), config()),
    ).rejects.toBeInstanceOf(FleetContextOverflowError);
  });

  it('delegates policy and manifest authority to FleetManager', async () => {
    const fleetManager = {
      canSpawn: vi.fn(() => null),
      assignNicknameAndRecord: vi.fn(),
      recordSpawn: vi.fn(),
    };
    const host = makeHost({ fleetManager: fleetManager as never });
    await spawn(host, config({ name: 'subagent' }), { input: 1 });
    expect(fleetManager.assignNicknameAndRecord).toHaveBeenCalled();
    expect(fleetManager.recordSpawn).toHaveBeenCalled();
    expect(host.spawnCount).toBe(0);
    expect(host.manifestEntries.size).toBe(0);
  });

  it.each([
    ['max_spawn_depth', FleetSpawnBudgetError],
    ['max_spawns', FleetSpawnBudgetError],
    ['max_cost_usd', FleetCostCapError],
    ['max_tokens', FleetTokenCapError],
    ['max_context_load', FleetContextOverflowError],
  ] as const)('maps FleetManager rejection %s', async (kind, ErrorType) => {
    const host = makeHost({
      fleetManager: {
        canSpawn: () => ({ kind, limit: 1, observed: 2 }),
        assignNicknameAndRecord: vi.fn(),
        recordSpawn: vi.fn(),
      } as never,
    });
    await expect(spawn(host, config())).rejects.toBeInstanceOf(ErrorType);
  });
});
