import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServerConfig } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMcp,
  disableMcp,
  discoverMcp,
  enableMcp,
  listMcp,
  type McpManageDeps,
  removeMcp,
  restartMcp,
  updateMcp,
} from '../src/manage.js';

let tmp: string;
let configPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manage-'));
  configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1 }));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Minimal MCPRegistry stub — records calls, lets tests drive list() state. */
function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as never;
}

function deps(registry: unknown, presets: Record<string, MCPServerConfig> = {}): McpManageDeps {
  return { configPath, registry: registry as never, presets } as McpManageDeps;
}

const githubPreset: MCPServerConfig = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  description: 'GitHub MCP',
};

async function readServers(): Promise<Record<string, MCPServerConfig>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.mcpServers ?? {};
}

describe('addMcp', () => {
  it('adds a preset by name (disabled) without starting it', async () => {
    const registry = makeRegistry();
    const r = await addMcp({ name: 'github' }, deps(registry, { github: githubPreset }));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.github?.command).toBe('npx');
    expect(servers.github?.enabled).toBe(false);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).not.toHaveBeenCalled();
  });

  it('persists url for an http transport server', async () => {
    const r = await addMcp(
      {
        name: 'context7',
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        enabled: false,
      },
      deps(makeRegistry()),
    );
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.context7?.url).toBe('https://mcp.context7.com/mcp');
    expect(servers.context7?.transport).toBe('streamable-http');
  });

  it('persists only the environment variable name for remote bearer auth', async () => {
    const r = await addMcp(
      {
        name: 'zai-web-search',
        transport: 'streamable-http',
        url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
        bearerTokenEnv: 'Z_AI_API_KEY',
        enabled: false,
      },
      deps(makeRegistry()),
    );
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers['zai-web-search']?.bearerTokenEnv).toBe('Z_AI_API_KEY');
    expect(servers['zai-web-search']?.headers).toBeUndefined();
  });

  it('persists the lazy flag', async () => {
    await addMcp(
      { name: 'github', enabled: false, lazy: true },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const servers = await readServers();
    expect(servers.github?.lazy).toBe(true);
  });

  it('persists health thresholds', async () => {
    await addMcp(
      {
        name: 'github',
        enabled: false,
        health: { thresholds: { callLatencyP95Ms: 500, inFlightCalls: 8 } },
      },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const servers = await readServers();
    expect(servers.github?.health).toEqual({
      thresholds: { callLatencyP95Ms: 500, inFlightCalls: 8 },
    });
  });

  it('normalizes a bare "http" transport to streamable-http', async () => {
    await addMcp(
      { name: 'svc', transport: 'http', url: 'https://x.example/mcp', enabled: false },
      deps(makeRegistry()),
    );
    const servers = await readServers();
    expect(servers.svc?.transport).toBe('streamable-http');
  });

  it('starts the server when enabled', async () => {
    const registry = makeRegistry();
    const r = await addMcp(
      { name: 'github', enabled: true },
      deps(registry, { github: githubPreset }),
    );
    expect(r.ok).toBe(true);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'github', enabled: true }),
    );
    const servers = await readServers();
    expect(servers.github?.enabled).toBe(true);
  });

  it('rejects a duplicate', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const r = await addMcp({ name: 'github' }, deps(makeRegistry(), { github: githubPreset }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already exists');
  });

  it('rejects an unknown name with no explicit config', async () => {
    const r = await addMcp({ name: 'nope' }, deps(makeRegistry(), { github: githubPreset }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Unknown server');
  });

  it('rejects a name-only add when no presets are registered at all', async () => {
    const r = await addMcp({ name: 'anything' }, { configPath, registry: makeRegistry() });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('No configuration provided');
  });

  it('soft-warns when config persisted but the registry fails to start', async () => {
    const registry = makeRegistry({ start: vi.fn().mockRejectedValue(new Error('boom')) });
    const r = await addMcp(
      { name: 'github', enabled: true },
      deps(registry, { github: githubPreset }),
    );
    expect(r.ok).toBe(true);
    expect(r.registryError).toBe('boom');
    expect(r.message).toContain('failed to start');
    const servers = await readServers();
    expect(servers.github).toBeDefined();
  });
});

describe('updateMcp', () => {
  it('merges fields and keeps url', async () => {
    await addMcp(
      { name: 'context7', transport: 'streamable-http', url: 'https://a/mcp', enabled: false },
      deps(makeRegistry()),
    );
    const r = await updateMcp({ name: 'context7', description: 'docs' }, deps(makeRegistry()));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.context7?.url).toBe('https://a/mcp');
    expect(servers.context7?.description).toBe('docs');
  });

  it('errors when the server is not in config', async () => {
    const r = await updateMcp({ name: 'ghost' }, deps(makeRegistry()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not found');
  });
});

describe('removeMcp', () => {
  it('stops and deletes', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const registry = makeRegistry();
    const r = await removeMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    expect(await readServers()).toEqual({});
  });

  it('errors when not present', async () => {
    const r = await removeMcp('ghost', deps(makeRegistry()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not found');
  });
});

describe('enable / disable', () => {
  it('enable flips config and starts', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const registry = makeRegistry();
    const r = await enableMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((await readServers()).github?.enabled).toBe(true);
  });

  it('disable stops and flips config', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry();
    const r = await disableMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    expect((await readServers()).github?.enabled).toBe(false);
  });
});

describe('restart / discover', () => {
  it('restarts a registered server', async () => {
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['a', 'b'] }],
    });
    const r = await restartMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'github',
    );
    expect(r.tools).toEqual(['a', 'b']);
  });

  it('discover returns the live tool list', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 1, tools: ['x'] }],
    });
    const r = await discoverMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual(['x']);
    expect(r.message).toContain('1 tool');
  });

  it('restartMcp returns error when restart throws', async () => {
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['a', 'b'] }],
      restart: vi.fn().mockRejectedValue(new Error('restart-failed')),
    });
    const r = await restartMcp('github', deps(registry));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('restart-failed');
  });

  it('restartMcp starts from config when server is not in registry but is in config', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({
      list: () => [],
      start: vi.fn().mockResolvedValue(undefined),
    });
    const r = await restartMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
  });

  it('restartMcp returns error when server is not in config or registry', async () => {
    const r = await restartMcp('ghost', deps(makeRegistry()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not in config');
  });

  it('discoverMcp propagates restart failure', async () => {
    const r = await discoverMcp('ghost', deps(makeRegistry()));
    expect(r.ok).toBe(false);
  });

  it('addMcp with enabled config starts via registry.start when not alreadyRegistered', async () => {
    const registry = makeRegistry({ list: () => [] });
    await addMcp({ name: 'github', enabled: true }, deps(registry, { github: githubPreset }));
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'github', enabled: true }),
    );
  });

  it('enableMcp calls restart on registry for already-registered server', async () => {
    // Add disabled server first (writes to config)
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    // Now enable it with a registry that lists it as registered
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['a', 'b'] }],
      restart: vi.fn().mockResolvedValue(undefined),
    });
    const r = await enableMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    // The persisted config travels with the restart — a bare restart(name)
    // would keep the slot's original config.
    expect((registry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ name: 'github', enabled: true }),
    );
  });

  it('updateMcp with disabled server stops it', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({ list: () => [] });
    const r = await updateMcp({ name: 'github', enabled: false }, deps(registry));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.github?.enabled).toBe(false);
  });
});

describe('listMcp', () => {
  it('merges live state + tools into config entries', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['t1', 't2'] }],
    });
    const list = await listMcp(deps(registry));
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('connected');
    expect(list[0]?.tools).toEqual(['t1', 't2']);
  });

  it('reports stopped servers as stopped with no tools', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const list = await listMcp(deps(makeRegistry()));
    expect(list[0]?.status).toBe('stopped');
    expect(list[0]?.tools).toEqual([]);
  });

  it('surfaces a malformed config instead of reporting an empty list', async () => {
    // A malformed config must fail loudly. Silently reading it as empty is
    // what let the next read-modify-write persist a config containing only
    // `mcpServers`, destroying every other top-level profile setting.
    await fs.writeFile(configPath, '{invalid');
    await expect(listMcp(deps(makeRegistry()))).rejects.toThrow(/not valid JSON/i);
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: [] }));
    await expect(listMcp(deps(makeRegistry()))).resolves.toEqual([]);
  });

  it('projects every optional server field and transport variant', async () => {
    const registry = makeRegistry({ markDisabled: vi.fn() });
    await addMcp(
      {
        name: 'complete',
        transport: 'sse',
        description: 'complete config',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'value' },
        url: 'https://example.test',
        headers: { 'X-Test': 'yes' },
        allowedTools: ['one'],
        permission: 'confirm',
        enabled: false,
        lazy: false,
        passthroughEnv: ['HOME'],
        health: { thresholds: { inFlightCalls: 2 } },
      },
      deps(registry),
    );
    const [server] = await listMcp(deps(registry));
    expect(server).toMatchObject({
      transport: 'sse',
      description: 'complete config',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'value' },
      url: 'https://example.test',
      lazy: false,
    });
    expect(
      (registry as { markDisabled: ReturnType<typeof vi.fn> }).markDisabled,
    ).toHaveBeenCalled();

    await addMcp(
      { name: 'stdio', transport: 'unknown', command: 'cmd', enabled: false },
      deps(registry),
    );
    expect((await readServers()).stdio?.transport).toBe('stdio');
  });
});

describe('management edge cases', () => {
  it('rejects missing names for every operation', async () => {
    const d = deps(makeRegistry());
    await expect(addMcp({ name: '' }, d)).resolves.toMatchObject({ ok: false });
    await expect(updateMcp({ name: '' }, d)).resolves.toMatchObject({ ok: false });
    await expect(removeMcp('', d)).resolves.toMatchObject({ ok: false });
    await expect(enableMcp('', d)).resolves.toMatchObject({ ok: false });
    await expect(disableMcp('', d)).resolves.toMatchObject({ ok: false });
    await expect(restartMcp('', d)).resolves.toMatchObject({ ok: false });
    await expect(discoverMcp('', d)).resolves.toMatchObject({ ok: false });
  });

  it('reports missing enable and disable targets', async () => {
    const d = deps(makeRegistry());
    await expect(enableMcp('missing', d)).resolves.toMatchObject({ ok: false });
    await expect(disableMcp('missing', d)).resolves.toMatchObject({ ok: false });
  });

  it('rejects prototype-polluting names without touching Object.prototype', async () => {
    // H-2 (security report VF-04): `servers` is a JSON.parse result, so a bare
    // `servers['__proto__']` lookup resolved to Object.prototype — truthy, so
    // the `if (!cfg)` guard passed and `cfg.enabled = …` polluted every object
    // in the process. The name screen must reject before any lookup.
    const d = deps(makeRegistry());
    await expect(enableMcp('__proto__', d)).resolves.toMatchObject({ ok: false });
    await expect(disableMcp('__proto__', d)).resolves.toMatchObject({ ok: false });
    await expect(removeMcp('__proto__', d)).resolves.toMatchObject({ ok: false });
    await expect(restartMcp('__proto__', d)).resolves.toMatchObject({ ok: false });
    await expect(discoverMcp('__proto__', d)).resolves.toMatchObject({ ok: false });
    await expect(addMcp({ name: 'constructor' }, d)).resolves.toMatchObject({ ok: false });
    await expect(updateMcp({ name: 'prototype' }, d)).resolves.toMatchObject({ ok: false });
    expect((Object.prototype as { enabled?: unknown }).enabled).toBeUndefined();
  });

  it('restarts an enabled update and an already tracked add', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const updateRegistry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', tools: [] }],
    });
    await expect(
      updateMcp({ name: 'github', description: 'updated' }, deps(updateRegistry)),
    ).resolves.toMatchObject({ ok: true });
    // Regression: the edit must reach the live registry, not just config.json.
    expect((updateRegistry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ name: 'github', description: 'updated', enabled: true }),
    );

    const addRegistry = makeRegistry({
      list: () => [{ name: 'tracked', state: 'stopped', tools: [] }],
    });
    await addMcp(
      { name: 'tracked', transport: 'stdio', command: 'cmd', enabled: true },
      deps(addRegistry),
    );
    expect((addRegistry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'tracked',
      expect.objectContaining({ name: 'tracked', command: 'cmd' }),
    );
  });

  it('swallows stop failures and forgets removed registry state', async () => {
    const forget = vi.fn();
    const registry = makeRegistry({
      stop: vi.fn().mockRejectedValue(new Error('not running')),
      forget,
      markDisabled: vi.fn(),
    });
    await addMcp({ name: 'github', enabled: false }, deps(registry, { github: githubPreset }));
    await expect(removeMcp('github', deps(registry))).resolves.toMatchObject({ ok: true });
    expect(forget).toHaveBeenCalledWith('github');
  });

  it('formats non-Error registry failures and plural discovery results', async () => {
    const failing = makeRegistry({
      list: () => [{ name: 'registered', state: 'failed', tools: [] }],
      restart: vi.fn().mockRejectedValue('plain failure'),
    });
    await expect(restartMcp('registered', deps(failing))).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('plain failure'),
    });

    const discoveryRegistry = makeRegistry({
      list: () => [{ name: 'registered', state: 'connected', tools: ['one', 'two'] }],
    });
    await expect(discoverMcp('registered', deps(discoveryRegistry))).resolves.toMatchObject({
      message: expect.stringContaining('2 tools'),
    });
  });

  it('cleans up the temporary file when atomic rename fails', async () => {
    await fs.rm(configPath);
    await fs.mkdir(configPath);
    await expect(
      addMcp(
        { name: 'server', transport: 'stdio', command: 'cmd', enabled: false },
        deps(makeRegistry()),
      ),
    ).rejects.toThrow();
    const leftovers = (await fs.readdir(tmp)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('treats a URL by itself as explicit configuration', async () => {
    await expect(
      addMcp(
        { name: 'url-only', url: 'https://example.test', enabled: false },
        { configPath, registry: makeRegistry() },
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('readConfig corrupt-config guard', () => {
  const proofInput = { name: 'proof', transport: 'stdio', command: 'node', enabled: false };

  it('addMcp rejects and leaves a corrupt config.json untouched instead of resetting it', async () => {
    // A corrupt file must fail loudly: reading it as `{}` makes the next
    // read-modify-write persist a config containing only `mcpServers`,
    // silently destroying every other top-level profile setting.
    const corrupt = '{"keep":true,"mcpServers":';
    await fs.writeFile(configPath, corrupt, 'utf8');
    await expect(addMcp(proofInput, deps(makeRegistry()))).rejects.toThrow(/not valid JSON/i);
    expect(await fs.readFile(configPath, 'utf8')).toBe(corrupt);
  });

  it('addMcp rejects a config.json that is valid JSON but not an object', async () => {
    await fs.writeFile(configPath, '[]', 'utf8');
    await expect(addMcp(proofInput, deps(makeRegistry()))).rejects.toThrow(/JSON object/i);
    expect(await fs.readFile(configPath, 'utf8')).toBe('[]');
  });

  it('a missing config.json still takes the fresh-config path', async () => {
    await fs.rm(configPath);
    await expect(addMcp(proofInput, deps(makeRegistry()))).resolves.toMatchObject({ ok: true });
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.proof).toBeTruthy();
  });

  it('a valid config keeps its other top-level keys across an add', async () => {
    await fs.writeFile(configPath, JSON.stringify({ keep: { v: 1 } }), 'utf8');
    await expect(addMcp(proofInput, deps(makeRegistry()))).resolves.toMatchObject({ ok: true });
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.keep).toEqual({ v: 1 });
    expect(written.mcpServers.proof).toBeTruthy();
  });
});

describe('buildConfig timeout-field preservation', () => {
  // `buildConfig` rebuilds an MCPServerConfig field-by-field. It once omitted
  // `startupTimeoutMs` and `requestTimeoutMs`, so any add-from-preset that
  // carried a tuned timeout (the first-party `ssh` preset sets
  // `requestTimeoutMs: 180_000`) persisted `undefined`, and every update reset
  // a hand-tuned value back to the client default (10s / 60s). These fields are
  // real config (MCPServerConfig) that the runtime consumes via
  // registry-connect-loop -> MCPClient, so dropping them is silent data loss.
  const sshLikePreset: MCPServerConfig = {
    name: 'ssh',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-ssh-manager'],
    permission: 'confirm',
    requestTimeoutMs: 180_000,
  };

  it('addMcp from a preset keeps the preset requestTimeoutMs', async () => {
    const r = await addMcp({ name: 'ssh' }, deps(makeRegistry(), { ssh: sshLikePreset }));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.ssh?.requestTimeoutMs).toBe(180_000);
  });

  it('updateMcp does not reset hand-tuned startup/request timeouts', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          custom: {
            name: 'custom',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            enabled: false,
            startupTimeoutMs: 30_000,
            requestTimeoutMs: 180_000,
          },
        },
      }),
      'utf8',
    );
    const r = await updateMcp({ name: 'custom', description: 'renamed' }, deps(makeRegistry()));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.custom?.startupTimeoutMs).toBe(30_000);
    expect(servers.custom?.requestTimeoutMs).toBe(180_000);
    // control: a field buildConfig does copy must still round-trip unchanged.
    expect(servers.custom?.command).toBe('node');
  });

  it('an explicit input timeout overrides the base on update', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          custom: {
            name: 'custom',
            transport: 'stdio',
            command: 'node',
            requestTimeoutMs: 180_000,
          },
        },
      }),
      'utf8',
    );
    const r = await updateMcp({ name: 'custom', requestTimeoutMs: 5_000 }, deps(makeRegistry()));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.custom?.requestTimeoutMs).toBe(5_000);
  });
});
