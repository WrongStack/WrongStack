import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, MCPServerConfig } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMcpArgs, runMcpManagementCommand } from '../src/slash-commands/mcp-utils.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmp: string;
let configPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-utils-'));
  configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1 }));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as never;
}

function fakePreset(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    description: 'GitHub MCP',
    enabled: false,
    ...overrides,
  } as MCPServerConfig;
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'p',
    model: 'm',
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

// ── parseMcpArgs ─────────────────────────────────────────────────────────────

describe('parseMcpArgs', () => {
  it('returns list action for empty args', () => {
    expect(parseMcpArgs('')).toEqual({ action: 'list', name: '' });
  });

  it('returns list action explicitly', () => {
    expect(parseMcpArgs('list')).toEqual({ action: 'list', name: '' });
  });

  it('parses add with --enable', () => {
    expect(parseMcpArgs('add github --enable')).toEqual({
      action: 'add',
      name: 'github',
      enable: true,
    });
  });

  it('parses add without --enable', () => {
    expect(parseMcpArgs('add github')).toEqual({
      action: 'add',
      name: 'github',
      enable: false,
    });
  });

  it('parses add with -e short flag', () => {
    expect(parseMcpArgs('add github -e')?.enable).toBe(true);
  });

  it('returns null for add without server name', () => {
    expect(parseMcpArgs('add')).toBeNull();
  });

  it('parses remove/enable/disable/restart', () => {
    expect(parseMcpArgs('remove github')?.action).toBe('remove');
    expect(parseMcpArgs('enable github')?.action).toBe('enable');
    expect(parseMcpArgs('disable github')?.action).toBe('disable');
    expect(parseMcpArgs('restart github')?.action).toBe('restart');
  });

  it('returns null for remove/enable/disable/restart without name', () => {
    expect(parseMcpArgs('remove')).toBeNull();
    expect(parseMcpArgs('enable')).toBeNull();
    expect(parseMcpArgs('disable')).toBeNull();
    expect(parseMcpArgs('restart')).toBeNull();
  });

  it('returns null for unknown action', () => {
    expect(parseMcpArgs('frobulate github')).toBeNull();
  });
});

// ── runMcpManagementCommand ──────────────────────────────────────────────────

describe('runMcpManagementCommand — list', () => {
  it('shows "all presets configured" when configured covers everything', async () => {
    const config = fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } });
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      {
        config,
        configPath,
        mcpRegistry: makeRegistry({
          list: () => [{ name: 'github', state: 'connected', toolCount: 5 }],
        }),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Configured servers:');
    expect(stripAnsi(out)).toContain('github');
    expect(stripAnsi(out)).toContain('All presets are already configured');
  });

  it('lists unconfigured presets when none configured', async () => {
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset(), other: fakePreset({ name: 'other' }) },
      },
    );
    expect(stripAnsi(out)).toContain('Available presets');
    expect(stripAnsi(out)).toContain('github');
    expect(stripAnsi(out)).toContain('other');
  });

  it('renders all state badges', async () => {
    const states = ['connected', 'connecting', 'reconnecting', 'disconnected', 'failed', 'mystery'];
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      {
        config: fakeConfig({
          mcpServers: Object.fromEntries(
            states.map((s) => [s, fakePreset({ name: s, enabled: true })]),
          ),
        }),
        configPath,
        mcpRegistry: makeRegistry({
          list: () => states.map((s) => ({ name: s, state: s, toolCount: 0 })),
        }),
        allServerPresets: { github: fakePreset() },
      },
    );
    const clean = stripAnsi(out);
    expect(clean).toContain('● connected');
    expect(clean).toContain('◐ connecting');
    expect(clean).toContain('◑ reconnecting');
    expect(clean).toContain('○ disconnected');
    expect(clean).toContain('✗ failed');
  });

  it('marks deny-permission presets with warning indicator', async () => {
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: {
          deny: fakePreset({ name: 'deny', permission: 'deny' as never }),
          allow: fakePreset({ name: 'allow' }),
        },
      },
    );
    expect(out).toMatch(/deny.*⚠/);
  });

  it('shows disabled label for entries with enabled: false', async () => {
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      {
        config: fakeConfig({
          mcpServers: { github: fakePreset({ enabled: false }) },
        }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('disabled');
  });
});

describe('runMcpManagementCommand — add', () => {
  it('errors on unknown preset name', async () => {
    const out = await runMcpManagementCommand(
      { action: 'add', name: 'nope' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(out).toContain('Unknown server "nope"');
    expect(out).toContain('github');
  });

  it('writes the preset to config and starts it when enabled=true', async () => {
    const registry = makeRegistry();
    const out = await runMcpManagementCommand(
      { action: 'add', name: 'github', enable: true },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Enabled and started');
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'github', enabled: true }),
    );
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.github.enabled).toBe(true);
  });

  it('writes preset disabled when --enable not passed', async () => {
    const out = await runMcpManagementCommand(
      { action: 'add', name: 'github', enable: false },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Added');
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.github.enabled).toBe(false);
  });

  it('updates existing entry instead of creating duplicate', async () => {
    const out = await runMcpManagementCommand(
      { action: 'add', name: 'github', enable: true },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: false }) } }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Updated');
  });
});

describe('runMcpManagementCommand — remove', () => {
  it('errors when server not in config', async () => {
    const out = await runMcpManagementCommand(
      { action: 'remove', name: 'github' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(out).toContain('not in config');
  });

  it('stops the server then removes from config', async () => {
    const registry = makeRegistry();
    const out = await runMcpManagementCommand(
      { action: 'remove', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Removed');
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers).toEqual({});
  });

  it('tolerates registry.stop rejection', async () => {
    const registry = makeRegistry({ stop: vi.fn().mockRejectedValue(new Error('not running')) });
    const out = await runMcpManagementCommand(
      { action: 'remove', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Removed');
  });
});

describe('runMcpManagementCommand — enable', () => {
  it('errors if not in config', async () => {
    const out = await runMcpManagementCommand(
      { action: 'enable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(out).toContain('not in config');
  });

  it('uses restart path on already-enabled server', async () => {
    const registry = makeRegistry();
    const out = await runMcpManagementCommand(
      { action: 'enable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('already enabled and running');
    expect((registry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalled();
  });

  it('falls back to start() when restart on enabled server fails', async () => {
    const registry = makeRegistry({
      restart: vi.fn().mockRejectedValue(new Error('not running')),
    });
    const out = await runMcpManagementCommand(
      { action: 'enable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Enabled');
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
  });

  it('enables a disabled server, writes config, then starts', async () => {
    const registry = makeRegistry();
    const out = await runMcpManagementCommand(
      { action: 'enable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: false }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Enabled');
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.github.enabled).toBe(true);
  });

  it('reads current config from disk instead of a stale startup snapshot', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { github: fakePreset({ enabled: false }) } }),
    );
    const registry = makeRegistry({
      restart: vi.fn().mockRejectedValue(new Error('not running')),
    });
    const out = await runMcpManagementCommand(
      { action: 'enable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Enabled');
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
  });
});

describe('runMcpManagementCommand — disable', () => {
  it('errors when server not in config', async () => {
    const out = await runMcpManagementCommand(
      { action: 'disable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(out).toContain('not in config');
  });

  it('stops the server and writes enabled:false', async () => {
    const registry = makeRegistry();
    const out = await runMcpManagementCommand(
      { action: 'disable', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: registry,
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Disabled');
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.github.enabled).toBe(false);
  });
});

describe('runMcpManagementCommand — restart', () => {
  it('errors when server not currently running', async () => {
    const out = await runMcpManagementCommand(
      { action: 'restart', name: 'github' },
      {
        config: fakeConfig({ mcpServers: {} }),
        configPath,
        mcpRegistry: makeRegistry(),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(out).toContain('not currently running');
  });

  it('restarts when present in registry', async () => {
    const out = await runMcpManagementCommand(
      { action: 'restart', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset({ enabled: true }) } }),
        configPath,
        mcpRegistry: makeRegistry({
          list: () => [{ name: 'github', state: 'connected', toolCount: 0 }],
        }),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Restarted');
  });

  it('reports failure when restart throws', async () => {
    const out = await runMcpManagementCommand(
      { action: 'restart', name: 'github' },
      {
        config: fakeConfig({ mcpServers: { github: fakePreset() } }),
        configPath,
        mcpRegistry: makeRegistry({
          list: () => [{ name: 'github', state: 'connected', toolCount: 0 }],
          restart: vi.fn().mockRejectedValue(new Error('crashed')),
        }),
        allServerPresets: { github: fakePreset() },
      },
    );
    expect(stripAnsi(out)).toContain('Failed to restart');
    expect(stripAnsi(out)).toContain('crashed');
  });
});
