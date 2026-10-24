import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../core/src/index.js';
import { ToolCapabilities } from '@wrongstack/core/security';
import { createMcpControlTool, type MCPRegistryHandle } from '../../src/management/mcp-control.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'test',
    model: 'test',
    context: {
      warnThreshold: 80,
      softThreshold: 90,
      hardThreshold: 95,
      preserveK: 10,
      eliseThreshold: 0,
    },
    tools: {
      defaultExecutionStrategy: 'parallel',
      maxIterations: 10,
      iterationTimeoutMs: 30000,
      sessionTimeoutMs: 60000,
      perIterationOutputCapBytes: 1_000_000,
    },
    log: { level: 'info' },
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

function fakeRegistry(overrides: Partial<MCPRegistryHandle> = {}): MCPRegistryHandle {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnValue([]),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('createMcpControlTool', () => {
  let tool: ReturnType<typeof createMcpControlTool>;
  let registry: MCPRegistryHandle;
  let getConfig: () => Config;
  let tmp: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-control-'));
    configPath = path.join(tmp, 'config.json');
    registry = fakeRegistry();
    getConfig = () => fakeConfig({ mcpServers: {} });
    tool = createMcpControlTool({ getConfig, configPath, registry });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('has name "mcp_control"', () => {
    expect(tool.name).toBe('mcp_control');
  });

  it('has category "mcp"', () => {
    expect(tool.category).toBe('mcp');
  });

  it('has permission "confirm"', () => {
    expect(tool.permission).toBe('confirm');
  });

  it('is mutating (writes config + spawns MCP servers)', () => {
    // mcp_control enable/disable writes the config file and spawns/kills MCP
    // server processes, so it must trip the permission confirmation gate.
    expect(tool.mutating).toBe(true);
  });

  it('declares config mutation capability', () => {
    expect(tool.capabilities).toContain(ToolCapabilities.CONFIG_MUTATE);
  });

  it('has riskTier "destructive" for UI/audit metadata', () => {
    // enable/restart spawn a server that, for stdio presets, runs `npx -y <pkg>`
    // (fetch+execute an npm package). Outside YOLO the CONFIG_MUTATE dangerous-
    // capability net still forces a confirm; in YOLO the risk tier is metadata.
    expect(tool.riskTier).toBe('destructive');
  });

  // ── list action ────────────────────────────────────────────────────────────

  it('list: empty config shows "no servers configured"', async () => {
    const result = await tool.execute({ action: 'list' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(result).toContain('No MCP servers configured');
  });

  it('list: shows configured servers', async () => {
    getConfig = () =>
      fakeConfig({
        mcpServers: {
          github: {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            description: 'GitHub API',
            enabled: true,
          },
        },
      });
    registry = fakeRegistry({
      describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }],
    });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    const result = await tool.execute({ action: 'list' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(result).toContain('github');
    expect(result).toContain('connected');
  });

  it('list and search: show a running server that has no config entry', async () => {
    // Started for this run only (`--mcp-config`): live in the registry, absent
    // from config. It used to be invisible, so in token-saving mode its tools
    // could never be activated.
    const activateServer = vi.fn();
    registry = fakeRegistry({
      describe: () => [{ name: 'elicit', state: 'connected', toolCount: 1, enabled: true }],
      activateServer,
      isActivated: () => false,
    });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    const run = (input: Record<string, unknown>) =>
      tool.execute(input as never, undefined as never, { signal: new AbortController().signal });

    const listed = await run({ action: 'list' });
    expect(listed).not.toContain('No MCP servers configured');
    expect(listed).toMatch(/elicit.*this run only.*connected.*1 tools/);

    const found = await run({ action: 'search', query: 'elic' });
    expect(found).toContain('Running servers matching "elic"');
    expect(found).toContain('elicit');

    await run({ action: 'activate', server: 'elicit' });
    expect(activateServer).toHaveBeenCalledWith('elicit');
  });

  // ── search action ─────────────────────────────────────────────────────────

  it('search: no query returns all unconfigured presets', async () => {
    const result = await tool.execute({ action: 'search' }, undefined as never, {
      signal: new AbortController().signal,
    });
    // Should contain filesystem since it's a preset not in config
    expect(result).toContain('filesystem');
    expect(result).toContain('github');
  });

  it('search: filters by keyword in name', async () => {
    const result = await tool.execute({ action: 'search', query: 'git' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(result).toContain('github');
    expect(result).toContain('git');
  });

  it('search: filters by keyword in description', async () => {
    const result = await tool.execute({ action: 'search', query: 'image' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(result).toContain('zai-vision');
    expect(result).toContain('minimax-vision');
  });

  it('search: unknown keyword shows helpful message', async () => {
    const result = await tool.execute(
      { action: 'search', query: 'xyznotfound' },
      undefined as never,
      { signal: new AbortController().signal },
    );
    expect(result).toContain('No servers match');
  });

  // ── enable action ──────────────────────────────────────────────────────────

  // Failures must THROW: the executor records a returned string as success.
  it('enable: missing server name throws', async () => {
    await expect(
      tool.execute({ action: 'enable' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('server` is required');
  });

  it('enable: unknown server throws with known list', async () => {
    await expect(
      tool.execute({ action: 'enable', server: 'nonexistent' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Unknown server "nonexistent"/);
  });

  it('enable: starts a preset server and writes to config', async () => {
    const result = await tool.execute({ action: 'enable', server: 'github' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(registry.start).toHaveBeenCalled();
    expect(result).toContain('Enabled');
    expect(result).toContain('github');
  });

  it('enable: already running server reports "already running"', async () => {
    registry = fakeRegistry({
      describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }],
    });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    const result = await tool.execute({ action: 'enable', server: 'github' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(result).toContain('already running');
  });

  // H-8 (security-check 2026-09-26): `import-claude-code` brings a repository's
  // .mcp.json servers in disabled, marked `origin: 'repository'`. Their
  // command is the repository's; turning one on is the user's decision, and
  // `mcp_control` is auto-approved under YOLO — so the tool refuses.
  it('enable: refuses a repository-imported server the user has not enabled', async () => {
    const repoServer = {
      name: 'tool',
      transport: 'stdio' as const,
      command: 'node',
      args: ['./scripts/mcp.js'],
      enabled: false,
      origin: 'repository' as const,
    };
    getConfig = () => fakeConfig({ mcpServers: { tool: repoServer } });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    await expect(
      tool.execute({ action: 'enable', server: 'tool' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/imported from a repository.*\/mcp enable tool/);
    expect(registry.start).not.toHaveBeenCalled();

    // Once the user has enabled it, restarting it through the tool is fine.
    getConfig = () => fakeConfig({ mcpServers: { tool: { ...repoServer, enabled: true } } });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    await tool.execute({ action: 'enable', server: 'tool' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(registry.start).toHaveBeenCalled();
  });

  // ── disable action ────────────────────────────────────────────────────────

  it('disable: missing server name throws', async () => {
    await expect(
      tool.execute({ action: 'disable' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('server` is required');
  });

  it('disable: unknown server throws a helpful error', async () => {
    await expect(
      tool.execute({ action: 'disable', server: 'github' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('not in config');
  });

  it('disable: stops server and updates config', async () => {
    getConfig = () =>
      fakeConfig({
        mcpServers: {
          github: {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            enabled: true,
          },
        },
      });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: getConfig().mcpServers }));
    tool = createMcpControlTool({ getConfig, configPath, registry });
    const result = await tool.execute({ action: 'disable', server: 'github' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(registry.stop).toHaveBeenCalledWith('github');
    expect(result).toContain('Disabled');
  });

  // ── restart action ───────────────────────────────────────────────────────

  it('restart: missing server name throws', async () => {
    await expect(
      tool.execute({ action: 'restart' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('server` is required');
  });

  it('restart: unknown server throws a helpful error', async () => {
    await expect(
      tool.execute({ action: 'restart', server: 'github' }, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('not configured');
  });

  it('restart: calls registry.restart for configured server', async () => {
    getConfig = () =>
      fakeConfig({
        mcpServers: {
          github: {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            enabled: true,
          },
        },
      });
    registry = fakeRegistry({
      describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }],
    });
    tool = createMcpControlTool({ getConfig, configPath, registry });
    const result = await tool.execute({ action: 'restart', server: 'github' }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(registry.restart).toHaveBeenCalledWith('github');
    expect(result).toContain('Restarted');
  });

  // ── unknown action ────────────────────────────────────────────────────────

  it('unknown action throws a helpful error', async () => {
    await expect(
      tool.execute({ action: 'frobnicate' } as never, undefined as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Unknown action "frobnicate"/);
  });
});
