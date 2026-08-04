import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MCP_ENV_MASK } from '@wrongstack/mcp';
import {
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpPromptGet,
  handleMcpPrompts,
  handleMcpRemove,
  handleMcpResourceRead,
  handleMcpResources,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
} from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
let configPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-h-'));
  configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1 }));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Fake OPEN WebSocket that records every JSON message it's sent. */
function fakeWs() {
  const sent: Array<{ type: string; payload?: unknown }> = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => sent.push(JSON.parse(data)),
    sent,
  };
}

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as never;
}

const msg = (type: string, payload?: unknown) => ({ type, payload }) as never;
const types = (ws: ReturnType<typeof fakeWs>) => ws.sent.map((m) => m.type);
const result = (ws: ReturnType<typeof fakeWs>) =>
  ws.sent.find((m) => m.type === 'mcp.operation_result')?.payload as {
    success: boolean;
    message: string;
  };

async function readServers() {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.mcpServers ?? {};
}

async function seed(servers: Record<string, unknown>) {
  await fs.writeFile(configPath, JSON.stringify({ version: 1, mcpServers: servers }));
}

// ── mcp.add ───────────────────────────────────────────────────────────────────

/**
 * Security scan 2026-08-04, finding M1. `mcp.add`/`mcp.update` take a
 * `command` + `args` off the wire, persist them, and spawn — the only
 * WS-reachable spawn path that never consulted the trust boundary its siblings
 * all go through.
 *
 * Note what these tests pin and what they don't: the DEFAULT compatibility
 * boundary allows everything except `critical` + `remote-client`, and these
 * actions are `elevated` (so the WebUI's MCP panel keeps working). So the
 * value under the default policy is the audit record, not a denial. What is
 * pinned here is that a boundary which DOES deny is actually honoured — i.e.
 * the call site exists and its verdict is respected.
 */
describe('mcp.add / mcp.update consult the trust boundary (M1)', () => {
  const denyAll = {
    evaluate: async () => ({
      kind: 'deny' as const,
      reason: 'test policy denies MCP configuration',
      policyId: 'test-deny',
    }),
  };

  it('mcp.add does not spawn or persist when the boundary denies', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', {
        name: 'evil',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'require("child_process").exec("id")'],
        enabled: true,
      }),
      configPath,
      registry,
      denyAll,
    );
    expect((await readServers()).evil).toBeUndefined();
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).not.toHaveBeenCalled();
    const result = ws.sent.find((m) => m.type === 'mcp.operation_result');
    expect((result?.payload as { success: boolean }).success).toBe(false);
    expect((result?.payload as { message: string }).message).toContain('denied');
  });

  it('mcp.update does not re-persist when the boundary denies', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpUpdate(
      ws as never,
      msg('mcp.update', {
        name: 'whatever',
        transport: 'stdio',
        command: 'node',
        args: ['-e', '1'],
        enabled: true,
      }),
      configPath,
      registry,
      denyAll,
    );
    const result = ws.sent.find((m) => m.type === 'mcp.operation_result');
    expect((result?.payload as { success: boolean }).success).toBe(false);
    expect((result?.payload as { message: string }).message).toContain('denied');
  });

  it('an allowing boundary leaves behavior unchanged', async () => {
    const allowAll = {
      evaluate: async () => ({
        kind: 'allow' as const,
        reason: 'test policy allows',
        policyId: 'test-allow',
      }),
    };
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        enabled: true,
      }),
      configPath,
      registry,
      allowAll,
    );
    expect((await readServers()).fs?.command).toBe('npx');
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
  });
});

describe('mcp.add (WebUI "Add Custom" / "Add" official)', () => {
  it('adds a custom stdio server (enabled) → added + connected + ok, config persisted', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        enabled: true,
      }),
      configPath,
      registry,
    );
    const s = (await readServers()).fs;
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '.']);
    expect(s.enabled).toBe(true);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
    expect(types(ws)).toEqual(
      expect.arrayContaining(['mcp.server.added', 'mcp.server.connected', 'mcp.operation_result']),
    );
    expect(result(ws).success).toBe(true);
  });

  it('adds an official http server with url (context7), url persisted', async () => {
    const ws = fakeWs();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', {
        name: 'context7',
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        enabled: false,
      }),
      configPath,
      makeRegistry(),
    );
    expect((await readServers()).context7?.url).toBe('https://mcp.context7.com/mcp');
    expect(types(ws)).toContain('mcp.server.added');
    expect(result(ws).success).toBe(true);
  });

  it('normalizes a bare "http" transport to streamable-http', async () => {
    const ws = fakeWs();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', { name: 'svc', transport: 'http', url: 'https://x/mcp', enabled: false }),
      configPath,
      makeRegistry(),
    );
    expect((await readServers()).svc?.transport).toBe('streamable-http');
  });

  it('persists the lazy flag from the dialog checkbox', async () => {
    const ws = fakeWs();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        enabled: false,
        lazy: true,
      }),
      configPath,
      makeRegistry(),
    );
    expect((await readServers()).fs?.lazy).toBe(true);
  });

  it('rejects a duplicate name', async () => {
    await seed({ fs: { name: 'fs', transport: 'stdio', command: 'npx' } });
    const ws = fakeWs();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', { name: 'fs', transport: 'stdio', command: 'npx' }),
      configPath,
      makeRegistry(),
    );
    expect(result(ws).success).toBe(false);
    expect(result(ws).message).toContain('already exists');
  });

  it('rejects a missing name', async () => {
    const ws = fakeWs();
    await handleMcpAdd(
      ws as never,
      msg('mcp.add', { transport: 'stdio' }),
      configPath,
      makeRegistry(),
    );
    expect(result(ws).success).toBe(false);
  });
});

// ── mcp.list ──────────────────────────────────────────────────────────────────

describe('mcp.list (WebUI panel load / refresh)', () => {
  it('returns an empty list when nothing is configured', async () => {
    const ws = fakeWs();
    await handleMcpList(ws as never, msg('mcp.list'), configPath, makeRegistry());
    const list = ws.sent.find((m) => m.type === 'mcp.list');
    expect((list!.payload as { servers: unknown[] }).servers).toEqual([]);
  });

  it('merges live registry status + real tool names', async () => {
    await seed({ github: { name: 'github', transport: 'stdio', command: 'npx', enabled: true } });
    const ws = fakeWs();
    await handleMcpList(
      ws as never,
      msg('mcp.list'),
      configPath,
      makeRegistry({
        list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['a', 'b'] }],
      }),
    );
    const servers = (
      ws.sent.find((m) => m.type === 'mcp.list')!.payload as {
        servers: Array<{ status: string; tools: string[] }>;
      }
    ).servers;
    expect(servers[0]?.status).toBe('connected');
    expect(servers[0]?.tools).toEqual(['a', 'b']);
  });

  it('includes persisted config details needed by the Edit dialog', async () => {
    await seed({
      github: {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'configured-token' },
        enabled: false,
      },
      remote: {
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
      },
    });
    const ws = fakeWs();

    await handleMcpList(ws as never, msg('mcp.list'), configPath, makeRegistry());

    const servers = (
      ws.sent.find((m) => m.type === 'mcp.list')!.payload as {
        servers: Array<{
          name: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        }>;
      }
    ).servers;
    // WS-036 (inverted). This asserted `env: { GITHUB_TOKEN: 'configured-token' }`
    // — i.e. that `mcp.list` echoes MCP server credentials verbatim over the
    // WebSocket to the browser. That is the leak, not the contract. The value
    // is now replaced by MCP_ENV_MASK; `buildConfig` restores the stored secret
    // when a caller echoes the mask back, so the edit form still round-trips.
    expect(servers.find((server) => server.name === 'github')).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: MCP_ENV_MASK },
    });
    expect(JSON.stringify(servers)).not.toContain('configured-token');
    expect(servers.find((server) => server.name === 'remote')?.url).toBe(
      'https://mcp.example.com/mcp',
    );
  });

  it('maps a dormant lazy server to "sleeping" with cached tools', async () => {
    await seed({
      ctx: { name: 'ctx', transport: 'stdio', command: 'npx', enabled: true, lazy: true },
    });
    const ws = fakeWs();
    await handleMcpList(
      ws as never,
      msg('mcp.list'),
      configPath,
      makeRegistry({ list: () => [{ name: 'ctx', state: 'dormant', toolCount: 1, tools: ['t'] }] }),
    );
    const s = (
      ws.sent.find((m) => m.type === 'mcp.list')!.payload as {
        servers: Array<{ status: string; lazy?: boolean; tools: string[] }>;
      }
    ).servers[0];
    expect(s?.status).toBe('sleeping');
    expect(s?.lazy).toBe(true);
    expect(s?.tools).toEqual(['t']);
  });

  it('includes the payload-free operational health snapshot', async () => {
    await seed({ github: { name: 'github', transport: 'stdio', command: 'npx', enabled: true } });
    const ws = fakeWs();
    await handleMcpList(
      ws as never,
      msg('mcp.list'),
      configPath,
      makeRegistry({
        list: () => [{ name: 'github', state: 'connected', toolCount: 0, tools: [] }],
        operationalHealth: () => [
          {
            name: 'github',
            healthState: 'degraded',
            failures: { transport: 1, protocol: 0, tool: 2 },
            callLatency: { count: 3, p50Ms: 10, p95Ms: 20 },
            reconnectCount: 1,
            wakeCount: 0,
            sleepCount: 0,
            restartCount: 0,
            inFlightCalls: 0,
            peakInFlightCalls: 1,
          },
        ],
      }),
    );
    const server = (
      ws.sent.find((item) => item.type === 'mcp.list')!.payload as {
        servers: Array<{ health?: { healthState: string; failures: { tool: number } } }>;
      }
    ).servers[0];
    expect(server?.health).toMatchObject({ healthState: 'degraded', failures: { tool: 2 } });
    expect(JSON.stringify(server?.health)).not.toContain('command');
  });
});

// ── mcp.update (WebUI "Edit" dialog) ──────────────────────────────────────────

describe('mcp.update (WebUI Edit dialog)', () => {
  beforeEach(async () => {
    await seed({
      ctx: {
        name: 'ctx',
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        description: 'old',
        enabled: false,
      },
    });
  });

  it('preserves url/command when the Edit dialog omits them (blanked fields)', async () => {
    // The Edit dialog clears command/args/url and sends only changed fields —
    // the omitted ones must NOT be wiped from config.
    const ws = fakeWs();
    await handleMcpUpdate(
      ws as never,
      msg('mcp.update', { name: 'ctx', description: 'new description' }),
      configPath,
      makeRegistry(),
    );
    const s = (await readServers()).ctx;
    expect(s.url).toBe('https://mcp.context7.com/mcp'); // preserved
    expect(s.description).toBe('new description'); // updated
    expect(result(ws).success).toBe(true);
    expect(types(ws)).toContain('mcp.server.updated');
  });

  it('toggling "Enable server" on → starts the server + persists enabled:true', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpUpdate(
      ws as never,
      msg('mcp.update', { name: 'ctx', enabled: true }),
      configPath,
      registry,
    );
    expect((await readServers()).ctx.enabled).toBe(true);
    expect(
      (registry as { start: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> }).start
        .mock.calls.length +
        (registry as { restart: ReturnType<typeof vi.fn> }).restart.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it('changing the url persists the new value', async () => {
    const ws = fakeWs();
    await handleMcpUpdate(
      ws as never,
      msg('mcp.update', { name: 'ctx', url: 'https://new.example/mcp' }),
      configPath,
      makeRegistry(),
    );
    expect((await readServers()).ctx.url).toBe('https://new.example/mcp');
  });

  it('errors on a server that is not in config', async () => {
    const ws = fakeWs();
    await handleMcpUpdate(
      ws as never,
      msg('mcp.update', { name: 'ghost' }),
      configPath,
      makeRegistry(),
    );
    expect(result(ws).success).toBe(false);
    expect(result(ws).message).toContain('not found');
  });
});

// ── mcp.wake / mcp.sleep / mcp.discover (card buttons) ─────────────────────────

describe('mcp.wake / mcp.sleep / mcp.discover (server card buttons)', () => {
  beforeEach(async () => {
    await seed({ github: { name: 'github', transport: 'stdio', command: 'npx', enabled: true } });
  });

  it('wake restarts a registered server → waking + connected + ok', async () => {
    const ws = fakeWs();
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 0, tools: [] }],
    });
    await handleMcpWake(ws as never, msg('mcp.wake', { name: 'github' }), configPath, registry);
    expect((registry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'github',
    );
    expect(types(ws)).toEqual(
      expect.arrayContaining(['mcp.server.waking', 'mcp.server.connected']),
    );
    expect(result(ws).success).toBe(true);
  });

  it('sleep stops the process but KEEPS enabled:true in config', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpSleep(ws as never, msg('mcp.sleep', { name: 'github' }), configPath, registry);
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    // Sleep is NOT disable — config stays enabled.
    expect((await readServers()).github.enabled).toBe(true);
    expect(types(ws)).toContain('mcp.server.sleeping');
    expect(result(ws).success).toBe(true);
  });

  it('discover reports live tools from the server', async () => {
    const ws = fakeWs();
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 3, tools: ['x', 'y', 'z'] }],
    });
    await handleMcpDiscover(
      ws as never,
      msg('mcp.discover', { name: 'github' }),
      configPath,
      registry,
    );
    const d = ws.sent.find((m) => m.type === 'mcp.server.discovered')?.payload as {
      tools: string[];
    };
    expect(d.tools).toEqual(['x', 'y', 'z']);
    expect(result(ws).success).toBe(true);
  });

  it('wake reports failure (not crash) when the server fails to restart', async () => {
    const ws = fakeWs();
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 0, tools: [] }],
      restart: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await handleMcpWake(ws as never, msg('mcp.wake', { name: 'github' }), configPath, registry);
    expect(result(ws).success).toBe(false);
    expect(result(ws).message).toContain('boom');
  });
});

describe('MCP resource/prompt discovery and explicit selection', () => {
  it('lists resources and templates without returning their contents', async () => {
    const ws = fakeWs();
    const registry = makeRegistry({
      listResources: vi.fn().mockResolvedValue([{ uri: 'repo://guide', name: 'guide' }]),
      listResourceTemplates: vi
        .fn()
        .mockResolvedValue([{ uriTemplate: 'repo://{path}', name: 'file' }]),
    });

    await handleMcpResources(
      ws as never,
      msg('mcp.resources', { name: 'docs', refresh: true }),
      configPath,
      registry,
    );

    expect(ws.sent.find((item) => item.type === 'mcp.resources')?.payload).toMatchObject({
      name: 'docs',
      resources: [{ name: 'guide' }],
      resourceTemplates: [{ name: 'file' }],
    });
  });

  it('lists prompts with structured arguments', async () => {
    const ws = fakeWs();
    const registry = makeRegistry({
      listPrompts: vi
        .fn()
        .mockResolvedValue([{ name: 'review', arguments: [{ name: 'target', required: true }] }]),
    });

    await handleMcpPrompts(ws as never, msg('mcp.prompts', { name: 'docs' }), configPath, registry);

    expect(ws.sent.find((item) => item.type === 'mcp.prompts')?.payload).toMatchObject({
      prompts: [{ name: 'review' }],
    });
  });

  it('returns selected resource content only in an untrusted provenance envelope', async () => {
    const ws = fakeWs();
    const insertion = {
      kind: 'resource',
      untrusted: true,
      byteSize: 5,
      provenance: { origin: 'mcp', serverName: 'docs', capability: 'resource' },
      contents: [{ uri: 'repo://guide', text: 'hello' }],
    };
    const registry = makeRegistry({
      selectResourceForInsertion: vi.fn().mockResolvedValue(insertion),
    });

    await handleMcpResourceRead(
      ws as never,
      msg('mcp.resource.read', { name: 'docs', uri: 'repo://guide' }),
      configPath,
      registry,
    );

    expect(ws.sent).toContainEqual({ type: 'mcp.content.selected', payload: insertion });
  });

  it('validates prompt arguments and does not echo secret values in provenance', async () => {
    const ws = fakeWs();
    const insertion = {
      kind: 'prompt',
      untrusted: true,
      byteSize: 10,
      provenance: {
        origin: 'mcp',
        serverName: 'docs',
        capability: 'prompt',
        promptName: 'review',
        promptArgumentNames: ['token'],
      },
      messages: [],
    };
    const select = vi.fn().mockResolvedValue(insertion);
    const registry = makeRegistry({ selectPromptForInsertion: select });

    await handleMcpPromptGet(
      ws as never,
      msg('mcp.prompt.get', {
        name: 'docs',
        prompt: 'review',
        arguments: { token: 'secret-value' },
      }),
      configPath,
      registry,
    );

    expect(select).toHaveBeenCalledWith('docs', 'review', { token: 'secret-value' });
    const selected = ws.sent.find((item) => item.type === 'mcp.content.selected');
    expect(JSON.stringify(selected?.payload)).not.toContain('secret-value');
  });

  it('returns structured errors for invalid selection payloads', async () => {
    const ws = fakeWs();
    await handleMcpResourceRead(
      ws as never,
      msg('mcp.resource.read', { name: 'docs' }),
      configPath,
      makeRegistry(),
    );
    expect(ws.sent.find((item) => item.type === 'mcp.content.error')?.payload).toMatchObject({
      action: 'resource.read',
    });
  });
});

// ── mcp.enable / mcp.disable / mcp.remove ─────────────────────────────────────

describe('mcp.enable / mcp.disable / mcp.remove', () => {
  beforeEach(async () => {
    await seed({ github: { name: 'github', transport: 'stdio', command: 'npx', enabled: false } });
  });

  it('enable flips config and starts', async () => {
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpEnable(ws as never, msg('mcp.enable', { name: 'github' }), configPath, registry);
    expect((await readServers()).github?.enabled).toBe(true);
    expect(types(ws)).toContain('mcp.server.connected');
  });

  it('disable stops and flips config to false', async () => {
    await seed({ github: { name: 'github', transport: 'stdio', command: 'npx', enabled: true } });
    const ws = fakeWs();
    const registry = makeRegistry();
    await handleMcpDisable(
      ws as never,
      msg('mcp.disable', { name: 'github' }),
      configPath,
      registry,
    );
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    expect((await readServers()).github?.enabled).toBe(false);
    expect(types(ws)).toContain('mcp.server.sleeping');
  });

  it('remove deletes from config + emits removed', async () => {
    const ws = fakeWs();
    await handleMcpRemove(
      ws as never,
      msg('mcp.remove', { name: 'github' }),
      configPath,
      makeRegistry(),
    );
    expect(await readServers()).toEqual({});
    expect(types(ws)).toContain('mcp.server.removed');
  });

  it('remove errors when the server is not present', async () => {
    const ws = fakeWs();
    await handleMcpRemove(
      ws as never,
      msg('mcp.remove', { name: 'ghost' }),
      configPath,
      makeRegistry(),
    );
    expect(result(ws).success).toBe(false);
  });
});

// ── registry-missing guard (defensive) ────────────────────────────────────────

describe('registry-missing guard', () => {
  it('every mutating op reports a clean failure (no crash) without a registry', async () => {
    for (const [handler, type] of [
      [handleMcpAdd, 'mcp.add'],
      [handleMcpUpdate, 'mcp.update'],
      [handleMcpRemove, 'mcp.remove'],
      [handleMcpEnable, 'mcp.enable'],
      [handleMcpDisable, 'mcp.disable'],
      [handleMcpWake, 'mcp.wake'],
      [handleMcpSleep, 'mcp.sleep'],
      [handleMcpDiscover, 'mcp.discover'],
    ] as const) {
      const ws = fakeWs();
      await handler(ws as never, msg(type, { name: 'x' }), configPath, undefined);
      expect(result(ws).success).toBe(false);
    }
  });
});
