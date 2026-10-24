import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, hoisted state so the mocked MCPClient can be inspected from tests.
const h = vi.hoisted(() => ({
  connectCalls: 0,
  callToolCalls: 0,
  closes: 0,
  listResourcesCalls: 0,
  listPromptsCalls: 0,
  resourcesChanged: undefined as ((name: string) => void) | undefined,
  promptsChanged: undefined as ((name: string) => void) | undefined,
  tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
  ] as { name: string; description?: string; inputSchema: Record<string, unknown> }[],
  resourcePages: [
    {
      resources: [{ uri: 'mem://guide', name: 'guide' }],
      nextCursor: 'page-2',
    },
    { resources: [{ uri: 'mem://reference', name: 'reference' }] },
  ],
}));

vi.mock('../src/client.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeClient {
    opts: { name: string };
    constructor(opts: { name: string }) {
      this.opts = opts;
    }
    async connect() {
      h.connectCalls++;
    }
    listTools() {
      return h.tools;
    }
    getServerMetadata() {
      return {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {},
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: { name: 'fake', version: '1.0.0' },
      };
    }
    async listResources(opts: { cursor?: string } = {}) {
      h.listResourcesCalls++;
      return opts.cursor ? h.resourcePages[1] : h.resourcePages[0];
    }
    async listResourceTemplates() {
      return { resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'memory' }] };
    }
    async readResource(uri: string) {
      return { contents: [{ uri, text: 'resource text' }] };
    }
    async subscribeResource() {}
    async unsubscribeResource() {}
    async listPrompts() {
      h.listPromptsCalls++;
      return { prompts: [{ name: 'review' }] };
    }
    async getPrompt(name: string) {
      return { messages: [{ role: 'user', content: { type: 'text', text: name } }] };
    }
    async callTool() {
      h.callToolCalls++;
      return { content: 'ok', isError: false };
    }
    async close() {
      h.closes++;
    }
    addExitListener() {}
    removeExitListener() {}
    addDisconnectListener() {}
    removeDisconnectListener() {}
    addToolsChangedListener() {}
    removeToolsChangedListener() {}
    addResourcesChangedListener(listener: (name: string) => void) {
      h.resourcesChanged = listener;
    }
    removeResourcesChangedListener(listener: (name: string) => void) {
      if (h.resourcesChanged === listener) h.resourcesChanged = undefined;
    }
    addPromptsChangedListener(listener: (name: string) => void) {
      h.promptsChanged = listener;
    }
    removePromptsChangedListener(listener: (name: string) => void) {
      if (h.promptsChanged === listener) h.promptsChanged = undefined;
    }
  }
  return { ...actual, MCPClient: FakeClient };
});

// Import AFTER the mock so the registry binds to FakeClient.
const { MCPRegistry } = await import('../src/registry.js');

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

const lazyCfg = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'never-actually-run',
  args: [],
  lazy: true,
  ...extra,
});

let tmp: string;
let toolReg: ToolRegistry;
let events: EventBus;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-lazy-'));
  toolReg = new ToolRegistry();
  events = new EventBus();
  h.connectCalls = 0;
  h.callToolCalls = 0;
  h.closes = 0;
  h.listResourcesCalls = 0;
  h.listPromptsCalls = 0;
  h.resourcesChanged = undefined;
  h.promptsChanged = undefined;
  h.resourcePages = [
    {
      resources: [{ uri: 'mem://guide', name: 'guide' }],
      nextCursor: 'page-2',
    },
    { resources: [{ uri: 'mem://reference', name: 'reference' }] },
  ];
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function toolNames(reg: InstanceType<typeof MCPRegistry>, name: string): string[] {
  return reg.list().find((s) => s.name === name)?.tools ?? [];
}

describe('MCPRegistry lazy-connect', () => {
  it('cold-discovers once and writes a manifest when no cache exists', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    // No cache → one discovery connect.
    expect(h.connectCalls).toBe(1);
    expect(toolNames(reg, 'svc')).toContain('mcp__svc__echo');
    // Manifest persisted for next boot.
    const manifest = await fs.readFile(path.join(tmp, 'mcp-tools', 'svc.json'), 'utf8');
    expect(manifest).toContain('echo');
    expect(manifest).toContain('mem://guide');
    expect(manifest).toContain('review');
    await reg.stopAll();
  });

  it('publishes bounded operational health and call telemetry', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    const operations: unknown[] = [];
    const unsubscribe = reg.onOperation((event) => operations.push(event));
    await reg.start(lazyCfg('private-server'));

    const tool = toolReg.list().find((item) => item.name === 'mcp__private-server__echo');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('expected wrapped MCP tool');
    await tool.execute({ token: 'not-in-telemetry' }, {} as Parameters<typeof tool.execute>[1], {
      signal: new AbortController().signal,
    });

    const health = reg.operationalHealth()[0]!;
    expect(health).toMatchObject({
      name: 'private-server',
      healthState: 'healthy',
      failures: { transport: 0, protocol: 0, tool: 0 },
      inFlightCalls: 0,
      peakInFlightCalls: 1,
    });
    expect(health.connectionLatency.count).toBe(1);
    expect(health.discoveryLatency.count).toBe(1);
    expect(health.callLatency.count).toBe(1);
    expect(JSON.stringify({ operations, health })).not.toContain('not-in-telemetry');
    expect(JSON.stringify({ operations, health })).not.toContain('echo');

    unsubscribe();
    await reg.stopAll();
  });

  it('registers from cache as dormant WITHOUT spawning on the next boot', async () => {
    // First boot: cold discovery writes the manifest.
    const reg1 = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg1.start(lazyCfg('svc'));
    await reg1.stopAll();

    // Second boot with a fresh registry + tool registry: should NOT connect.
    h.connectCalls = 0;
    const toolReg2 = new ToolRegistry();
    const reg2 = new MCPRegistry({
      toolRegistry: toolReg2,
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await reg2.start(lazyCfg('svc'));
    expect(h.connectCalls).toBe(0); // dormant — process not spawned
    expect(reg2.list().find((s) => s.name === 'svc')?.state).toBe('dormant');
    // Tools are still visible to the model.
    expect(toolReg2.list().some((t) => t.name === 'mcp__svc__echo')).toBe(true);
    expect(reg2.getCatalog('svc')).toMatchObject({
      resources: [{ name: 'guide' }, { name: 'reference' }],
      resourceTemplates: [{ name: 'memory' }],
      prompts: [{ name: 'review' }],
    });
    await expect(reg2.listResources('svc')).resolves.toHaveLength(2);
    expect(h.connectCalls).toBe(0);
    const mutable = reg2.getCatalog('svc');
    if (mutable?.resources?.[0]) mutable.resources[0].name = 'changed-by-caller';
    expect(reg2.getCatalog('svc')?.resources?.[0]?.name).toBe('guide');
    await reg2.stopAll();
  });

  it('invalidates list-change caches and refreshes them on the next read', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(h.listResourcesCalls).toBe(2);
    expect(h.listPromptsCalls).toBe(1);

    h.resourcesChanged?.('svc');
    h.promptsChanged?.('svc');
    expect(reg.getCatalog('svc')?.resources).toBeUndefined();
    expect(reg.getCatalog('svc')?.resourceTemplates).toBeUndefined();
    expect(reg.getCatalog('svc')?.prompts).toBeUndefined();

    await expect(reg.listResources('svc')).resolves.toHaveLength(2);
    await expect(reg.listPrompts('svc')).resolves.toEqual([
      {
        name: 'review',
      },
    ]);
    expect(h.listResourcesCalls).toBe(4);
    expect(h.listPromptsCalls).toBe(2);
    await reg.stopAll();
  });

  it('delegates resource reads and prompt gets through the live client', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));

    await expect(reg.readResource('svc', 'mem://guide')).resolves.toEqual({
      contents: [{ uri: 'mem://guide', text: 'resource text' }],
    });
    await expect(reg.getPrompt('svc', 'review')).resolves.toMatchObject({
      messages: [{ content: { text: 'review' } }],
    });
    await expect(reg.subscribeResource('svc', 'mem://guide')).resolves.toBeUndefined();
    await expect(reg.unsubscribeResource('svc', 'mem://guide')).resolves.toBeUndefined();
    await expect(reg.selectResourceForInsertion('svc', 'mem://guide')).resolves.toMatchObject({
      untrusted: true,
      provenance: { serverName: 'svc', resourceUri: 'mem://guide' },
    });
    await expect(reg.selectPromptForInsertion('svc', 'review')).resolves.toMatchObject({
      untrusted: true,
      provenance: { serverName: 'svc', promptName: 'review' },
    });
    await reg.stopAll();
  });

  it('rejects repeated pagination cursors instead of looping forever', async () => {
    h.resourcePages = [
      { resources: [{ uri: 'mem://one', name: 'one' }], nextCursor: 'same' },
      { resources: [{ uri: 'mem://two', name: 'two' }], nextCursor: 'same' },
    ];
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));

    await expect(reg.listResources('svc', { refresh: true })).rejects.toThrow(
      /repeated cursor "same"/,
    );
    await reg.stopAll();
  });

  it('spawns on first tool call (single-flight under concurrency)', async () => {
    // Seed the cache so start() is dormant.
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    h.connectCalls = 0;
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');

    // Two concurrent ensureConnected calls → exactly one connect.
    const [c1, c2] = await Promise.all([reg.ensureConnected('svc'), reg.ensureConnected('svc')]);
    expect(c1).toBe(c2);
    expect(h.connectCalls).toBe(1);
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');
    await reg.stopAll();
  });

  it('a registered lazy tool wakes the server when executed', async () => {
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    h.connectCalls = 0;
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    const tool = toolReg.list().find((t) => t.name === 'mcp__svc__echo');
    expect(tool).toBeDefined();
    const out = await tool?.execute?.({}, {} as never, {} as never);
    expect(out).toBe('ok');
    expect(h.connectCalls).toBe(1); // execute spawned the dormant server
    expect(h.callToolCalls).toBe(1);
    await reg.stopAll();
  });

  it('auto-sleeps a connected lazy server after the idle timeout', async () => {
    const reg = new MCPRegistry({
      toolRegistry: toolReg,
      events,
      log: silentLog,
      cacheDir: tmp,
      idleTimeoutMs: 5,
    });
    await reg.start(lazyCfg('svc')); // cold discovery → connected
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');

    await new Promise((r) => setTimeout(r, 20)); // exceed the 5ms idle window
    // Invoke the private sweep directly (the interval would also fire it).
    await (reg as never as { sweepIdle(): Promise<void> }).sweepIdle();

    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');
    expect(h.closes).toBeGreaterThanOrEqual(1);
    // Tools stay registered so the next call can re-wake.
    expect(toolReg.list().some((t) => t.name === 'mcp__svc__echo')).toBe(true);
    await reg.stopAll();
  });

  // Regression: a lazy wake returned early once wrappers were registered, so a
  // server whose real tool list moved on kept the manifest's stale tools.
  it('re-registers a lazy server whose tool set changed since the manifest', async () => {
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(toolReg.get('mcp__svc__echo')).toBeDefined();

    const original = h.tools;
    h.tools = [{ name: 'echo_v2', inputSchema: { type: 'object', properties: {} } }];
    try {
      await reg.ensureConnected('svc');
      expect(toolReg.get('mcp__svc__echo')).toBeUndefined();
      expect(toolReg.get('mcp__svc__echo_v2')).toBeDefined();
      const manifest = await fs.readFile(path.join(tmp, 'mcp-tools', 'svc.json'), 'utf8');
      expect(manifest).toContain('echo_v2');
    } finally {
      h.tools = original;
      await reg.stopAll();
    }
  });

  // Regression: the manifest was written from `client.listTools()`, so a write
  // landing after an idle sleep persisted `tools: []` and the next boot came up
  // dormant with no tools at all.
  it('never overwrites a manifest with an empty tool list once the client is gone', async () => {
    const reg = new MCPRegistry({
      toolRegistry: toolReg,
      events,
      log: silentLog,
      cacheDir: tmp,
      idleTimeoutMs: 5,
    });
    await reg.start(lazyCfg('svc'));
    await new Promise((r) => setTimeout(r, 20));
    await (reg as never as { sweepIdle(): Promise<void> }).sweepIdle();
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');

    h.promptsChanged = undefined;
    // A catalog invalidation after sleep re-persists the manifest without a client.
    (reg as never as { onPromptsChanged(name: string): void }).onPromptsChanged('svc');
    await new Promise((r) => setTimeout(r, 20));
    const manifest = JSON.parse(
      await fs.readFile(path.join(tmp, 'mcp-tools', 'svc.json'), 'utf8'),
    ) as { tools: { name: string }[] };
    expect(manifest.tools.map((t) => t.name)).toEqual(['echo']);
    await reg.stopAll();
  });

  // Regression: restart(name) reconnected with the slot's ORIGINAL config, so
  // management updates persisted to disk but never reached the live server.
  it('restart(name, nextCfg) applies the edited configuration', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(lazyCfg('svc', { lazy: false, permission: 'confirm' }));
    await reg.restart('svc', lazyCfg('svc', { lazy: false, permission: 'auto', args: ['--new'] }));
    expect(toolReg.get('mcp__svc__echo')?.permission).toBe('auto');

    await reg.restart('svc', lazyCfg('svc', { enabled: false }));
    expect(reg.list()).toHaveLength(0);
    expect(reg.describe()).toEqual([expect.objectContaining({ name: 'svc', enabled: false })]);
    await expect(reg.restart('svc', lazyCfg('other'))).rejects.toThrow(/not registered/);
    await reg.stopAll();
  });

  // Regression: a client dying mid-handshake closes with its listeners still
  // attached; handling that as a disconnect raced a second reconnect against
  // the connect loop.
  it('ignores exit/disconnect signals for a slot that is not connected', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(lazyCfg('svc', { lazy: false }));
    const slot = (reg as never as { servers: Map<string, { state: string }> }).servers.get('svc');
    if (!slot) throw new Error('expected slot');
    slot.state = 'connecting';
    const disconnects: unknown[] = [];
    events.on('mcp.server.disconnected', (p) => disconnects.push(p));
    const api = reg as never as {
      onChildExit(name: string, code: number | null, signal: string | null): void;
      onTransportDisconnect(name: string): void;
    };
    api.onChildExit('svc', 1, null);
    api.onTransportDisconnect('svc');
    expect(slot.state).toBe('connecting');
    expect(disconnects).toEqual([]);
    expect(toolReg.get('mcp__svc__echo')).toBeDefined();
    slot.state = 'connected';
    await reg.stopAll();
  });

  // Regression: in lazyMode a tools/list_changed wiped an ACTIVATED server's
  // tools, and activate/deactivate emitted connection events on every call.
  it('keeps an activated lazyMode server registered across a tool-list change', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, lazyMode: true });
    await reg.start(lazyCfg('svc', { lazy: false }));
    expect(toolReg.get('mcp__svc__echo')).toBeUndefined();

    const connectionEvents: string[] = [];
    events.on('mcp.server.connected', () => connectionEvents.push('connected'));
    events.on('mcp.server.disconnected', () => connectionEvents.push('disconnected'));
    reg.activateServer('svc');
    expect(toolReg.get('mcp__svc__echo')).toBeDefined();

    const original = h.tools;
    h.tools = [{ name: 'echo_v2', inputSchema: { type: 'object', properties: {} } }];
    try {
      (reg as never as { onToolsChanged(name: string, tools: unknown[]): void }).onToolsChanged(
        'svc',
        h.tools,
      );
      expect(reg.isActivated('svc')).toBe(true);
      expect(toolReg.get('mcp__svc__echo_v2')).toBeDefined();
      expect(toolReg.get('mcp__svc__echo')).toBeUndefined();
      expect(reg.deactivateServer('svc')).toBe(1);
      expect(connectionEvents).toEqual([]);
    } finally {
      h.tools = original;
      await reg.stopAll();
    }
  });

  // Regression: WebUI "sleep" called stop(), which unregistered a lazy
  // server's tools instead of letting it go dormant.
  it('sleep() puts a lazy server dormant and keeps its tools callable', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');

    await reg.sleep('svc');
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');
    const tool = toolReg.get('mcp__svc__echo');
    expect(tool).toBeDefined();

    h.connectCalls = 0;
    await expect(tool?.execute({}, {} as never, {} as never)).resolves.toBe('ok');
    expect(h.connectCalls).toBe(1);

    const eager = new MCPRegistry({ toolRegistry: new ToolRegistry(), events, log: silentLog });
    await eager.start(lazyCfg('eager', { lazy: false }));
    await eager.sleep('eager');
    expect(eager.list().find((s) => s.name === 'eager')?.state).toBe('disconnected');
    await expect(eager.sleep('missing')).rejects.toThrow(/not registered/);
    await eager.stopAll();
    await reg.stopAll();
  });

  // Regression: in token-saving mode the model had no way to learn a server's
  // bare tool names or input schemas before calling mcp_use.
  it('describeTools lists bare names and schemas without waking a dormant server', async () => {
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    h.connectCalls = 0;
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(reg.describeTools('svc')).toEqual([
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(h.connectCalls).toBe(0);
    expect(reg.describeTools('ghost')).toBeUndefined();

    const filtered = new MCPRegistry({ toolRegistry: new ToolRegistry(), events, log: silentLog });
    await filtered.start(lazyCfg('only', { lazy: false, allowedTools: ['nothing-matches'] }));
    expect(filtered.describeTools('only')).toEqual([]);
    await filtered.stopAll();
    await reg.stopAll();
  });

  // Regression: stdio children inherited the process cwd, so presets using
  // `--project-root .` served whatever directory the host happened to run in.
  it('spawns stdio servers in the configured cwd', async () => {
    const reg = new MCPRegistry({
      toolRegistry: toolReg,
      events,
      log: silentLog,
      cwd: tmp,
    });
    await reg.start(lazyCfg('svc', { lazy: false }));
    const slot = (
      reg as never as { servers: Map<string, { client?: { opts: { cwd?: string } } }> }
    ).servers.get('svc');
    expect(slot?.client?.opts.cwd).toBe(tmp);
    await reg.stopAll();
  });

  it('falls back to eager connect when no cacheDir is configured', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(lazyCfg('svc')); // lazy requested but no cacheDir → eager
    expect(h.connectCalls).toBe(1);
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');
    await reg.stopAll();
  });
});
