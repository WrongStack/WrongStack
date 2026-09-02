import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpControlTool, type MCPRegistryHandle } from '../../src/tools/mcp-control.js';
import type { Config } from '../../src/index.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function fakeConfig(mcpServers: Config['mcpServers'] = {}): Config {
  return { version: 1, provider: 'test', model: 'test', mcpServers } as Config;
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

let tmp: string;
let configPath: string;
const sig = { signal: new AbortController().signal };
const run = (tool: ReturnType<typeof createMcpControlTool>, input: Record<string, unknown>) =>
  tool.execute(input as never, undefined as never, sig).then((r) => stripAnsi(r as string));
const make = (registry: MCPRegistryHandle, mcpServers: Config['mcpServers'] = {}) =>
  createMcpControlTool({ getConfig: () => fakeConfig(mcpServers), configPath, registry });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ctrl-'));
  configPath = path.join(tmp, 'config.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('mcp_control activate', () => {
  it('requires a server name', async () => {
    expect(await run(make(fakeRegistry()), { action: 'activate' })).toContain(
      'required for activate',
    );
  });
  it('reports when the registry lacks ephemeral activation', async () => {
    expect(await run(make(fakeRegistry()), { action: 'activate', server: 'x' })).toContain(
      'does not support ephemeral activation',
    );
  });
  it('reports an unregistered server', async () => {
    const reg = fakeRegistry({ activateServer: vi.fn(), describe: vi.fn().mockReturnValue([]) });
    expect(await run(make(reg), { action: 'activate', server: 'x' })).toContain(
      'is not registered',
    );
  });
  it('reports a not-connected server', async () => {
    const reg = fakeRegistry({
      activateServer: vi.fn(),
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'x', state: 'disconnected', toolCount: 0, enabled: true }]),
    });
    expect(await run(make(reg), { action: 'activate', server: 'x' })).toContain('is not connected');
  });
  it('reports an already-active server', async () => {
    const reg = fakeRegistry({
      activateServer: vi.fn(),
      isActivated: vi.fn().mockReturnValue(true),
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'x', state: 'connected', toolCount: 2, enabled: true }]),
    });
    expect(await run(make(reg), { action: 'activate', server: 'x' })).toContain('already active');
  });
  it('activates a connected server', async () => {
    const activateServer = vi.fn();
    const reg = fakeRegistry({
      activateServer,
      isActivated: vi.fn().mockReturnValue(false),
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'x', state: 'connected', toolCount: 3, enabled: true }]),
    });
    expect(await run(make(reg), { action: 'activate', server: 'x' })).toContain('Activated');
    expect(activateServer).toHaveBeenCalledWith('x');
  });
});

describe('mcp_control deactivate', () => {
  it('requires a server name', async () => {
    expect(await run(make(fakeRegistry()), { action: 'deactivate' })).toContain(
      'required for deactivate',
    );
  });
  it('reports when the registry lacks ephemeral deactivation', async () => {
    expect(await run(make(fakeRegistry()), { action: 'deactivate', server: 'x' })).toContain(
      'does not support ephemeral deactivation',
    );
  });
  it('reports a not-active server', async () => {
    const reg = fakeRegistry({
      deactivateServer: vi.fn(),
      isActivated: vi.fn().mockReturnValue(false),
    });
    expect(await run(make(reg), { action: 'deactivate', server: 'x' })).toContain(
      'not currently active',
    );
  });
  it('deactivates an active server', async () => {
    const deactivateServer = vi.fn().mockReturnValue(4);
    const reg = fakeRegistry({ deactivateServer, isActivated: vi.fn().mockReturnValue(true) });
    expect(await run(make(reg), { action: 'deactivate', server: 'x' })).toContain('Deactivated');
  });
});

describe('mcp_control restart + enable failures', () => {
  it('restarts a configured server', async () => {
    const reg = fakeRegistry({
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'github', state: 'connected', toolCount: 5, enabled: true }]),
    });
    expect(
      await run(make(reg, { github: { transport: 'stdio' } as never }), {
        action: 'restart',
        server: 'github',
      }),
    ).toContain('Restarted');
  });
  it('reports an unconfigured restart target', async () => {
    expect(await run(make(fakeRegistry()), { action: 'restart', server: 'ghost' })).toContain(
      'is not configured',
    );
  });
  it('surfaces a restart failure', async () => {
    const reg = fakeRegistry({ restart: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(
      await run(make(reg, { github: { transport: 'stdio' } as never }), {
        action: 'restart',
        server: 'github',
      }),
    ).toContain('Restart failed');
  });

  it('enables a known preset and reports tools, already-running, and start failure', async () => {
    // success
    const reg1 = fakeRegistry({
      describe: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([{ name: 'github', state: 'connected', toolCount: 7, enabled: true }]),
    });
    expect(await run(make(reg1), { action: 'enable', server: 'github' })).toContain(
      'Enabled and started',
    );
    // already running
    const reg2 = fakeRegistry({
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'github', state: 'connected', toolCount: 7, enabled: true }]),
    });
    expect(await run(make(reg2), { action: 'enable', server: 'github' })).toContain(
      'already running',
    );
    // start failure
    const reg3 = fakeRegistry({
      start: vi.fn().mockRejectedValue(new Error('spawn fail')),
      describe: vi.fn().mockReturnValue([]),
    });
    expect(await run(make(reg3), { action: 'enable', server: 'github' })).toContain(
      'Failed to start',
    );
  });

  it('enable persists enabled:true only after the server actually started', async () => {
    // Success path writes the config…
    const okReg = fakeRegistry({ describe: vi.fn().mockReturnValue([]) });
    await run(make(okReg), { action: 'enable', server: 'github' });
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers?: Record<string, { enabled?: boolean }>;
    };
    expect(written.mcpServers?.['github']?.enabled).toBe(true);

    // …while a failed start leaves the config untouched. Persist-before-start
    // flipped enabled:true for a server that never came up, so every later
    // boot retried it.
    await fs.rm(configPath, { force: true });
    const failReg = fakeRegistry({
      start: vi.fn().mockRejectedValue(new Error('spawn fail')),
      describe: vi.fn().mockReturnValue([]),
    });
    const out = await run(make(failReg), { action: 'enable', server: 'github' });
    expect(out).toContain('Config was left unchanged');
    await expect(fs.readFile(configPath, 'utf8')).rejects.toThrow();
  });
});

describe('mcp_control plain-text output', () => {
  it('emits no ANSI escape sequences in any rendered output', async () => {
    // Tool output is model-facing text rendered verbatim in transcripts and
    // non-TTY surfaces — hardcoded escapes turned into garbage there.
    const reg = fakeRegistry({
      describe: vi.fn().mockReturnValue([
        { name: 'github', state: 'connected', toolCount: 2, enabled: true },
        { name: 'other', state: 'failed', toolCount: 0, enabled: true },
      ]),
    });
    const tool = make(reg, {
      github: { transport: 'stdio', description: 'GitHub API' } as never,
      other: { transport: 'stdio', enabled: false } as never,
    });
    for (const input of [
      { action: 'list' },
      { action: 'search', query: 'git' },
      { action: 'enable', server: 'github' },
      { action: 'restart', server: 'github' },
    ]) {
      const raw = (await tool.execute(input as never, undefined as never, sig)) as string;
      expect(raw).not.toMatch(/\x1b\[/);
    }
  });
});

describe('mcp_control list/search/unknown rendering', () => {
  it('renders configured servers with state badges', async () => {
    const servers = {
      a: { transport: 'stdio', description: 'A srv' },
      b: { transport: 'stdio' },
      c: { transport: 'stdio' },
      d: { transport: 'stdio' },
      e: { transport: 'stdio', enabled: false },
    } as never;
    const reg = fakeRegistry({
      describe: vi.fn().mockReturnValue([
        { name: 'a', state: 'connecting', toolCount: 0, enabled: true },
        { name: 'b', state: 'reconnecting', toolCount: 0, enabled: true },
        { name: 'c', state: 'disconnected', toolCount: 0, enabled: true },
        { name: 'd', state: 'failed', toolCount: 0, enabled: true },
        { name: 'e', state: 'weird-state', toolCount: 0, enabled: false },
      ]),
    });
    const out = await run(make(reg, servers), { action: 'list' });
    expect(out).toContain('connecting');
    expect(out).toContain('reconnecting');
    expect(out).toContain('failed');
    expect(out).toContain('disabled');
  });

  it('search matches a configured server by name/description', async () => {
    const out = await run(
      make(fakeRegistry(), { mygit: { transport: 'stdio', description: 'git access' } as never }),
      { action: 'search', query: 'mygit' },
    );
    expect(out).toContain('Configured servers matching');
    expect(out).toContain('mygit');
  });

  it('reports an unknown action', async () => {
    expect(await run(make(fakeRegistry()), { action: 'frobnicate' })).toContain('Unknown action');
  });

  it('list prefers disk config over stale in-memory config after disable', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { ssh: { transport: 'stdio', enabled: false } } }),
    );
    const stale = { ssh: { transport: 'stdio', enabled: true } } as never;
    const out = await run(make(fakeRegistry(), stale), { action: 'list' });
    expect(out).toContain('ssh');
    expect(out).toContain('disabled');
    expect(out).not.toContain('● enabled');
  });

  it('disables a configured server even when stop() reports it was not running', async () => {
    // runDisable reads the config FILE (not getConfig()) and expectDefined()s the
    // entry, so the file must already contain the server.
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { github: { transport: 'stdio' } } }),
    );
    const reg = fakeRegistry({ stop: vi.fn().mockRejectedValue(new Error('not running')) });
    const out = await run(make(reg, { github: { transport: 'stdio' } as never }), {
      action: 'disable',
      server: 'github',
    });
    expect(out).toContain('was not running');
  });
});
