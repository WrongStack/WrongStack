import type { Config } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimePickerDeps } from '../src/wiring/runtime-picker-deps.js';

const mcpMocks = vi.hoisted(() => ({
  listMcp: vi.fn(),
  enableMcp: vi.fn(),
  disableMcp: vi.fn(),
}));

vi.mock('@wrongstack/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/mcp')>();
  return {
    ...actual,
    listMcp: mcpMocks.listMcp,
    enableMcp: mcpMocks.enableMcp,
    disableMcp: mcpMocks.disableMcp,
  };
});
vi.mock('@wrongstack/core/infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/infrastructure')>();
  return { ...actual, allServers: () => [] };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function harness(config: Config) {
  let current = config;
  const liveServers = [{ name: 'live', state: 'connected', toolCount: 3 }];
  const disabled = new Set<string>();
  const result = {
    getConfig: () => current,
    setConfig: vi.fn((next: Config) => {
      current = next;
    }),
    profileConfigPath: 'D:/profile/config.json',
    mcpRegistry: {
      list: vi.fn(() => liveServers),
      restart: vi.fn().mockResolvedValue(undefined),
    },
    toolRegistry: {
      isDisabled: vi.fn((name: string) => disabled.has(name)),
      enable: vi.fn((name: string) => disabled.delete(name)),
      disable: vi.fn((name: string) => disabled.add(name)),
    },
    configStore: { update: vi.fn() },
    getPluginItems: vi.fn().mockReturnValue([]),
    togglePlugin: vi.fn(),
    getToolItems: vi.fn().mockReturnValue([{ name: 'read', enabled: true }]),
    brain: undefined,
    brainSettings: { maxAutoRisk: 'high' },
    brainRuntime: undefined,
    getBrainLog: vi.fn().mockReturnValue([]),
  };
  return {
    result,
    liveServers,
    disabled,
    get current() {
      return current;
    },
  };
}

describe('createRuntimePickerDeps', () => {
  it('projects configured MCP servers against their live state', () => {
    const { result } = harness({
      mcpServers: {
        live: { name: 'live', transport: 'stdio', enabled: true, lazy: true },
        stopped: {
          name: 'stopped',
          transport: 'http',
          enabled: false,
          description: 'offline',
        },
      },
    } as unknown as Config);
    const deps = createRuntimePickerDeps(result as never);

    expect(deps.getMcpServers?.()).toEqual([
      expect.objectContaining({
        name: 'live',
        enabled: true,
        status: 'connected',
        toolCount: 3,
        lazy: true,
      }),
      expect.objectContaining({
        name: 'stopped',
        enabled: false,
        status: 'stopped',
        toolCount: 0,
      }),
    ]);
  });

  it('enables, disables, and restarts MCP servers with refreshed items', async () => {
    const { result, liveServers } = harness({} as Config);
    const deps = createRuntimePickerDeps(result as never);
    mcpMocks.listMcp.mockResolvedValue([
      {
        name: 'live',
        enabled: true,
        status: 'connected',
        transport: 'stdio',
        description: 'server',
        tools: ['one'],
        lazy: false,
      },
    ]);
    mcpMocks.disableMcp.mockResolvedValue({ ok: true, server: { status: 'connected' } });

    await expect(deps.onMcpToggle?.('live')).resolves.toMatchObject({
      message: '● live',
      error: undefined,
    });
    expect(mcpMocks.disableMcp).toHaveBeenCalled();

    liveServers.splice(0);
    mcpMocks.enableMcp.mockResolvedValue({ ok: false, message: 'cannot enable' });
    await expect(deps.onMcpToggle?.('new')).resolves.toMatchObject({
      error: 'cannot enable',
    });

    await expect(deps.onMcpRestart?.('new')).resolves.toMatchObject({
      message: 'Restarted "new".',
    });
    result.mcpRegistry.restart.mockRejectedValueOnce('restart failed');
    await expect(deps.onMcpRestart?.('new')).resolves.toMatchObject({
      error: 'restart failed',
    });
  });

  it('persists tool toggles and exposes bounded Brain history ages', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    const { result, disabled } = harness({
      tools: { disabledTools: [] },
    } as unknown as Config);
    result.getBrainLog.mockReturnValue([
      { kind: 'decision', question: 'seconds', outcome: 'yes', at: 9_990_000 },
      { kind: 'decision', question: 'minutes', outcome: 'yes', at: 9_700_000 },
      { kind: 'decision', question: 'one minute exact', outcome: 'yes', at: 9_940_000 },
      { kind: 'decision', question: 'minute boundary 3570s', outcome: 'yes', at: 6_430_000 },
      { kind: 'decision', question: 'minute boundary 3599s', outcome: 'yes', at: 6_401_000 },
      { kind: 'decision', question: 'hour boundary 3600s', outcome: 'yes', at: 6_400_000 },
      { kind: 'decision', question: 'hours', outcome: 'yes', at: 2_800_000 },
    ]);
    const deps = createRuntimePickerDeps(result as never);

    await expect(deps.onToolToggle?.('read')).resolves.toMatchObject({
      message: 'Disabled "read".',
    });
    expect(disabled.has('read')).toBe(true);
    expect(result.configStore.update).toHaveBeenCalledWith({
      tools: { disabledTools: ['read'] },
    });
    await expect(deps.onToolToggle?.('read')).resolves.toMatchObject({
      message: 'Enabled "read".',
    });
    expect(disabled.has('read')).toBe(false);

    expect(deps.getBrainData?.()).toEqual({
      riskLevel: 'high',
      log: [
        expect.objectContaining({ question: 'seconds', age: '10s' }),
        expect.objectContaining({ question: 'minutes', age: '5m' }),
        expect.objectContaining({ question: 'one minute exact', age: '1m' }),
        // Minute labels must stay in [1,59]m: rounding (not flooring) used to
        // emit the out-of-range "60m" for the whole [3570s, 3600s) window.
        expect.objectContaining({ question: 'minute boundary 3570s', age: '59m' }),
        expect.objectContaining({ question: 'minute boundary 3599s', age: '59m' }),
        expect.objectContaining({ question: 'hour boundary 3600s', age: '1h' }),
        expect.objectContaining({ question: 'hours', age: '2h' }),
      ],
    });
    expect(deps.onBrainRiskLevel?.('low')).toBeUndefined();
    expect(result.brainSettings.maxAutoRisk).toBe('low');
    now.mockRestore();
  });

  it('reports unavailable Brain settings', () => {
    const { result } = harness({} as Config);
    result.brainSettings = undefined as never;
    const deps = createRuntimePickerDeps(result as never);
    expect(deps.onBrainRiskLevel?.('high')).toBe('Brain settings not available.');
    expect(deps.getBrainData?.()).toEqual({ riskLevel: 'medium', log: [] });
  });
});
