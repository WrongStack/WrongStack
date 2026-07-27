import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobalPsSlashCommand } from '../src/ps-slash.js';

// Mock the persistent process registry with richer data for format tests
const mockGetGlobalStatus = vi.fn();
vi.mock('../src/process-registry-persistent.js', () => {
  const ProcessEntry = (overrides: Record<string, unknown> = {}) => ({
    pid: 12345,
    name: 'node',
    command: 'node wrongstack',
    startedAt: Date.now() - 300000,
    lastHeartbeat: Date.now() - 1000,
    instanceId: 'host1:12345:abc123',
    hostname: 'host1',
    protected: true,
    spawnMode: 'main',
    platform: process.platform,
    sessionId: 'sess-1',
    ...overrides,
  });

  return {
    getPersistentProcessRegistry: () => ({
      getInstanceId: () => 'host1:12345:abc123',
      getGlobalStatus: mockGetGlobalStatus,
    }),
    PersistentProcessRegistry: class {},
  };
});

import {
  formatInstanceList,
  formatInstanceSummary,
  formatGlobalStatus,
  listInstances,
  getInstanceCount,
  getGlobalProcessStatus,
} from '../src/ps-slash.js';

const makeInstanceMap = () => {
  const m = new Map<string, unknown[]>();
  m.set('host1:12345:abc123', [
    {
      pid: 12345,
      name: 'node',
      command: 'node wrongstack',
      startedAt: Date.now() - 300000,
      lastHeartbeat: Date.now() - 1000,
      instanceId: 'host1:12345:abc123',
      hostname: 'host1',
      protected: true,
      spawnMode: 'main',
      platform: process.platform,
      sessionId: 'sess-1',
    },
    {
      pid: 12346,
      name: 'bash',
      command: 'bash -c "echo hi"',
      startedAt: Date.now() - 120000,
      lastHeartbeat: Date.now() - 5000,
      instanceId: 'host1:12345:abc123',
      hostname: 'host1',
      protected: true,
      spawnMode: 'spawn',
      platform: process.platform,
    },
  ]);
  return m;
};

describe('ps-slash command handler', () => {
  beforeEach(() => {
    mockGetGlobalStatus.mockResolvedValue({
      instances: new Map(),
      totalProcesses: 0,
      protectedCount: 0,
      staleCount: 0,
    });
  });

  it('returns a slash command object with name and description', () => {
    const cmd = createGlobalPsSlashCommand();
    expect(cmd.name).toBe('ps');
    expect(cmd.description).toBeDefined();
    expect(typeof cmd.description).toBe('string');
    expect(cmd.description.length).toBeGreaterThan(0);
  });

  it('returns a handler function', () => {
    const cmd = createGlobalPsSlashCommand();
    expect(typeof cmd.handler).toBe('function');
  });

  it('handler returns a message object', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('');
    expect(result).toHaveProperty('message');
    expect(typeof result.message).toBe('string');
  });

  it('list subcommand (default) shows instance list', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('');
    expect(result.message).toContain('WrongStack Instances');
  });

  it('list subcommand works with "list" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('list');
    expect(result.message).toContain('WrongStack Instances');
  });

  it('list subcommand works with "ls" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('ls');
    expect(result.message).toContain('WrongStack Instances');
  });

  it('summary subcommand shows compact output', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('summary');
    expect(result.message).toContain('instance');
  });

  it('summary subcommand works with "sum" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('sum');
    expect(result.message).toContain('instance');
  });

  it('full subcommand shows global process status', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('full');
    expect(result.message).toContain('Global Process Status');
  });

  it('full subcommand works with "detail" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('detail');
    expect(result.message).toContain('Global Process Status');
  });

  it('count subcommand shows instance count', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('count');
    expect(result.message).toContain('instance');
    expect(result.message).toContain('active');
  });

  it('count subcommand works with "num" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('num');
    expect(result.message).toContain('instance');
  });

  it('hostname subcommand requires a pattern', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('hostname');
    expect(result.message).toContain('Usage');
  });

  it('hostname subcommand works with a pattern', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('hostname *');
    expect(result.message).toBeDefined();
  });

  it('hostname subcommand works with "host" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('host test-*');
    expect(result.message).toBeDefined();
  });

  it('status subcommand requires a valid state', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('status');
    expect(result.message).toContain('Usage');
  });

  it('status subcommand rejects invalid state', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('status unknown');
    expect(result.message).toContain('Usage');
  });

  it('status subcommand works with valid active state', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('status active');
    expect(result.message).toBeDefined();
  });

  it('status subcommand works with "state" keyword', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('state all');
    expect(result.message).toBeDefined();
  });

  it('unknown subcommand shows usage', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('unknown-command');
    expect(result.message).toContain('Usage');
  });

  it('empty input works (defaults to list)', async () => {
    const cmd = createGlobalPsSlashCommand();
    const result = await cmd.handler('   ');
    expect(result.message).toBeDefined();
  });
});

describe('ps-slash exported functions', () => {
  beforeEach(() => {
    mockGetGlobalStatus.mockResolvedValue({
      instances: makeInstanceMap(),
      totalProcesses: 2,
      protectedCount: 2,
      staleCount: 0,
    });
  });

  describe('listInstances', () => {
    it('returns instances from the registry', async () => {
      const instances = await listInstances();
      expect(instances.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const instances = await listInstances({ status: 'active' });
      expect(Array.isArray(instances)).toBe(true);
    });

    it('filters by hostname glob pattern', async () => {
      const instances = await listInstances({ hostname: 'host*' });
      expect(Array.isArray(instances)).toBe(true);
    });

    it('includes stale instances when requested', async () => {
      const instances = await listInstances({ includeStale: true });
      expect(Array.isArray(instances)).toBe(true);
    });
  });

  describe('getInstanceCount', () => {
    it('returns counts with byHostname map', async () => {
      const count = await getInstanceCount();
      expect(count.total).toBeGreaterThanOrEqual(0);
      expect(typeof count.active).toBe('number');
      expect(typeof count.stale).toBe('number');
      expect(count.byHostname instanceof Map).toBe(true);
    });
  });

  describe('formatInstanceList', () => {
    it('returns formatted instance list', async () => {
      const output = await formatInstanceList();
      expect(output).toContain('WrongStack Instances');
    });

    it('shows "No instances" when none match', async () => {
      mockGetGlobalStatus.mockResolvedValue({
        instances: new Map(),
        totalProcesses: 0,
        protectedCount: 0,
        staleCount: 0,
      });
      const output = await formatInstanceList();
      expect(output).toContain('No instances');
    });
  });

  describe('formatInstanceSummary', () => {
    it('returns summary string with counts', async () => {
      const output = await formatInstanceSummary();
      expect(output.length).toBeGreaterThan(0);
    });

    it('shows no-instances message when empty', async () => {
      mockGetGlobalStatus.mockResolvedValue({
        instances: new Map(),
        totalProcesses: 0,
        protectedCount: 0,
        staleCount: 0,
      });
      const output = await formatInstanceSummary();
      expect(output).toContain('No active');
    });
  });

  describe('getGlobalProcessStatus', () => {
    it('returns structured status object', async () => {
      const status = await getGlobalProcessStatus();
      expect(status).toHaveProperty('localInstance');
      expect(status).toHaveProperty('allInstances');
      expect(status).toHaveProperty('summary');
      expect(status).toHaveProperty('timestamp');
      expect(typeof status.summary.totalProcesses).toBe('number');
    });
  });

  describe('formatGlobalStatus', () => {
    it('returns formatted global status string', async () => {
      const output = await formatGlobalStatus();
      expect(output).toContain('WrongStack Global Process Status');
    });

    it('shows protected and stale counts', async () => {
      const output = await formatGlobalStatus();
      expect(output).toContain('Protected');
      expect(output).toContain('Stale');
    });
  });
});
