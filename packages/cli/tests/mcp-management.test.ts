/**
 * Focused coverage for services/mcp-management.ts — the shared MCP
 * management service (parseMcpArgs + runMcpManagementCommand) used by both
 * the `/mcp` slash command and the `wstack mcp` subcommand.
 *
 * The config-file utilities (readJsonObjectFile/updateJsonObjectFile) and the
 * MCP registry are mocked; every action branch of the command switch is
 * exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readJsonObjectFile: vi.fn(),
  updateJsonObjectFile: vi.fn(),
  mcpRegistry: {
    list: vi.fn(),
    operationalHealth: vi.fn(),
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    markDisabled: vi.fn(),
    forget: vi.fn(),
  },
}));

vi.mock('@wrongstack/core/utils', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readJsonObjectFile: h.readJsonObjectFile,
    updateJsonObjectFile: h.updateJsonObjectFile,
  };
});

vi.mock('@wrongstack/mcp', () => ({
  MCPRegistry: class {},
}));

import { parseMcpArgs, runMcpManagementCommand } from '../src/services/mcp-management.js';
import type { MCPServerConfig } from '@wrongstack/core/types';

const preset: MCPServerConfig = {
  name: 'preset',
  transport: 'stdio',
  command: 'node',
  description: 'A preset server',
};

const configured: Record<string, MCPServerConfig> = {
  files: { ...preset, name: 'files', description: 'Files server' },
};

const all: Record<string, MCPServerConfig> = {
  files: { ...preset, name: 'files', description: 'Files server' },
  github: { ...preset, name: 'github', description: 'GitHub server', permission: 'deny' },
};

function deps(overrides: Partial<typeof h.mcpRegistry> = {}) {
  return {
    config: {} as never,
    configPath: '/tmp/config.json',
    mcpRegistry: { ...h.mcpRegistry, ...overrides } as never,
    allServerPresets: all,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readJsonObjectFile.mockResolvedValue({});
  h.updateJsonObjectFile.mockImplementation(async (_path, mutator) => {
    const current = {};
    await mutator(current);
  });
  h.mcpRegistry.list.mockReturnValue([]);
  h.mcpRegistry.operationalHealth.mockReturnValue([]);
  h.mcpRegistry.start.mockResolvedValue(undefined);
  h.mcpRegistry.restart.mockResolvedValue(undefined);
  h.mcpRegistry.stop.mockResolvedValue(undefined);
  h.mcpRegistry.markDisabled.mockReturnValue(undefined);
  h.mcpRegistry.forget.mockReturnValue(undefined);
});

describe('parseMcpArgs', () => {
  it('maps empty/list to list and parses subcommands with names and flags', () => {
    expect(parseMcpArgs('')).toEqual({ action: 'list', name: '' });
    expect(parseMcpArgs('list')).toEqual({ action: 'list', name: '' });
    expect(parseMcpArgs('add github --enable')).toEqual({
      action: 'add',
      name: 'github',
      enable: true,
    });
    expect(parseMcpArgs('add files -e')).toEqual({ action: 'add', name: 'files', enable: true });
    expect(parseMcpArgs('remove files')).toEqual({ action: 'remove', name: 'files' });
    expect(parseMcpArgs('enable files')).toEqual({ action: 'enable', name: 'files' });
    expect(parseMcpArgs('disable files')).toEqual({ action: 'disable', name: 'files' });
    expect(parseMcpArgs('restart files')).toEqual({ action: 'restart', name: 'files' });
  });

  it('returns null for missing names, unknown actions, and empty actions', () => {
    expect(parseMcpArgs('add')).toBeNull();
    expect(parseMcpArgs('remove')).toBeNull();
    expect(parseMcpArgs('bogus x')).toBeNull();
    expect(parseMcpArgs('   ')).toEqual({ action: 'list', name: '' });
  });
});

describe('runMcpManagementCommand', () => {
  it('lists configured servers with live state and available presets', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    h.mcpRegistry.list.mockReturnValue([
      { name: 'files', state: 'connected', toolCount: 3, tools: [] },
    ]);
    h.mcpRegistry.operationalHealth.mockReturnValue([
      {
        name: 'files',
        healthState: 'ok',
        failures: { transport: 0, protocol: 0, tool: 0 },
        callLatency: { p95Ms: 12 },
      },
    ]);
    const out = await runMcpManagementCommand(
      { action: 'list', name: '' },
      deps(),
    );
    expect(out).toContain('Configured servers:');
    expect(out).toContain('files');
    expect(out).toContain('● enabled');
    expect(out).toContain('● connected');
    expect(out).toContain('(3 tools)');
    expect(out).toContain('[ok; failures 0/0/0; call p95 12ms]');
    expect(out).toContain('github');
    expect(out).toContain('⚠'); // deny permission
  });

  it('lists a configured-but-not-running server with the not-running marker', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const out = await runMcpManagementCommand({ action: 'list', name: '' }, deps());
    expect(out).toContain('Configured servers:');
    expect(out).toContain('○ not running');
    expect(out).toContain('Available presets');
  });

  it('reports "All presets are already configured" when none remain', async () => {
    h.readJsonObjectFile.mockResolvedValue({
      mcpServers: { files: configured.files, github: all.github },
    });
    const out = await runMcpManagementCommand({ action: 'list', name: '' }, deps());
    expect(out).toContain('Configured servers:');
    expect(out).toContain('files');
    expect(out).toContain('github');
    expect(out).toContain('All presets are already configured.');
    // No unconfigured preset rows are listed.
    expect(out).not.toContain('  files  Files server');
  });

  it('adds a new preset and starts it', async () => {
    h.mcpRegistry.list.mockReturnValue([]);
    const out = await runMcpManagementCommand({ action: 'add', name: 'github', enable: true }, deps());
    expect(out).toContain('Enabled and started');
    expect(h.mcpRegistry.start).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(h.updateJsonObjectFile).toHaveBeenCalled();
  });

  it('adds disabled by default and marks the registry disabled', async () => {
    const out = await runMcpManagementCommand({ action: 'add', name: 'github' }, deps());
    expect(out).toContain('Added (disabled');
    expect(h.mcpRegistry.markDisabled).toHaveBeenCalled();
  });

  it('updates an existing server and restarts when already running', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    h.mcpRegistry.list.mockReturnValue([
      { name: 'files', state: 'connected', toolCount: 1, tools: [] },
    ]);
    const out = await runMcpManagementCommand(
      { action: 'add', name: 'files', enable: true },
      deps(),
    );
    expect(out).toContain('Updated and started');
    expect(h.mcpRegistry.restart).toHaveBeenCalledWith('files');
  });

  it('reports unknown servers with the available list', async () => {
    const out = await runMcpManagementCommand({ action: 'add', name: 'nope' }, deps());
    expect(out).toContain('Unknown server "nope"');
    expect(out).toContain('github');
  });

  it('reports a start failure as enabled-but-not-started', async () => {
    h.mcpRegistry.start.mockRejectedValue(new Error('spawn failed'));
    const out = await runMcpManagementCommand({ action: 'add', name: 'github', enable: true }, deps());
    expect(out).toContain('failed to start');
    expect(out).toContain('spawn failed');
  });

  it('removes a configured server and forgets it from the registry', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const out = await runMcpManagementCommand({ action: 'remove', name: 'files' }, deps());
    expect(out).toContain('Removed');
    expect(h.mcpRegistry.stop).toHaveBeenCalledWith('files');
    expect(h.mcpRegistry.forget).toHaveBeenCalledWith('files');
  });

  it('reports a missing server on remove', async () => {
    const out = await runMcpManagementCommand({ action: 'remove', name: 'nope' }, deps());
    expect(out).toContain('is not in config');
  });

  it('tolerates a failing stop during remove', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.mcpRegistry.stop.mockRejectedValue(new Error('gone'));
    const out = await runMcpManagementCommand({ action: 'remove', name: 'files' }, deps());
    expect(out).toContain('Removed');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('enables an already-enabled server by restarting it', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const out = await runMcpManagementCommand({ action: 'enable', name: 'files' }, deps());
    expect(out).toContain('already enabled');
    expect(h.mcpRegistry.restart).toHaveBeenCalledWith('files');
  });

  it('enables a disabled server in config and starts it', async () => {
    h.readJsonObjectFile.mockResolvedValue({
      mcpServers: { files: { ...configured.files, enabled: false } },
    });
    const out = await runMcpManagementCommand({ action: 'enable', name: 'files' }, deps());
    expect(out).toContain('Enabled');
    expect(h.mcpRegistry.restart).toHaveBeenCalled();
  });

  it('reports a missing server on enable', async () => {
    const out = await runMcpManagementCommand({ action: 'enable', name: 'nope' }, deps());
    expect(out).toContain('is not in config');
  });

  it('disables a server, stops it, and marks the registry', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const out = await runMcpManagementCommand({ action: 'disable', name: 'files' }, deps());
    expect(out).toContain('Disabled');
    expect(h.mcpRegistry.stop).toHaveBeenCalledWith('files');
    expect(h.mcpRegistry.markDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('reports a missing server on disable', async () => {
    const out = await runMcpManagementCommand({ action: 'disable', name: 'nope' }, deps());
    expect(out).toContain('is not in config');
  });

  it('restarts a running server and reports success', async () => {
    h.mcpRegistry.list.mockReturnValue([
      { name: 'files', state: 'connected', toolCount: 1, tools: [] },
    ]);
    const out = await runMcpManagementCommand({ action: 'restart', name: 'files' }, deps());
    expect(out).toContain('Restarted');
    expect(h.mcpRegistry.restart).toHaveBeenCalledWith('files');
  });

  it('reports a not-running server on restart', async () => {
    const out = await runMcpManagementCommand({ action: 'restart', name: 'files' }, deps());
    expect(out).toContain('is not currently running');
  });

  it('reports a failed restart', async () => {
    h.mcpRegistry.list.mockReturnValue([
      { name: 'files', state: 'connected', toolCount: 1, tools: [] },
    ]);
    h.mcpRegistry.restart.mockRejectedValue(new Error('crash'));
    const out = await runMcpManagementCommand({ action: 'restart', name: 'files' }, deps());
    expect(out).toContain('Failed to restart');
    expect(out).toContain('crash');
  });

  it('falls back to start when restarting an enabled server fails', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    h.mcpRegistry.restart.mockRejectedValue(new Error('restart down'));
    const out = await runMcpManagementCommand({ action: 'enable', name: 'files' }, deps());
    // cfg.enabled !== false → try restart, catch → start fallback (230-231).
    expect(out).toContain('Enabled');
    expect(h.mcpRegistry.start).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('falls back to start when enabling a disabled server fails to restart', async () => {
    h.readJsonObjectFile.mockResolvedValue({
      mcpServers: { files: { ...configured.files, enabled: false } },
    });
    h.mcpRegistry.restart.mockRejectedValue(new Error('restart down'));
    const out = await runMcpManagementCommand({ action: 'enable', name: 'files' }, deps());
    expect(out).toContain('Enabled');
    expect(h.mcpRegistry.start).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('tolerates a failing stop during disable', async () => {
    h.readJsonObjectFile.mockResolvedValue({ mcpServers: { files: configured.files } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.mcpRegistry.stop.mockRejectedValue(new Error('gone'));
    const out = await runMcpManagementCommand({ action: 'disable', name: 'files' }, deps());
    expect(out).toContain('Disabled');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('renders every state badge variant in the list', async () => {
    h.readJsonObjectFile.mockResolvedValue({
      mcpServers: {
        c1: configured.files,
        c2: configured.files,
        c3: configured.files,
        c4: configured.files,
        c5: { ...configured.files, name: 'c5' },
      },
    });
    h.mcpRegistry.list.mockReturnValue([
      { name: 'c1', state: 'connecting', toolCount: 0, tools: [] },
      { name: 'c2', state: 'reconnecting', toolCount: 0, tools: [] },
      { name: 'c3', state: 'disconnected', toolCount: 0, tools: [] },
      { name: 'c4', state: 'failed', toolCount: 0, tools: [] },
      { name: 'c5', state: 'weird', toolCount: 0, tools: [] },
    ]);
    const out = await runMcpManagementCommand({ action: 'list', name: '' }, deps());
    expect(out).toContain('◐ connecting');
    expect(out).toContain('◑ reconnecting');
    expect(out).toContain('○ disconnected');
    expect(out).toContain('✗ failed');
    expect(out).toContain('weird'); // fallthrough badge
  });
});
