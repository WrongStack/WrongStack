import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import type { ToolsChangedListener } from '../src/client-types.js';
import { MCPRegistry } from '../src/registry.js';

const manifest = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../src/manifest-cache.js', async (original) => ({
  ...(await original<typeof import('../src/manifest-cache.js')>()),
  readCapabilityManifest: manifest.read,
  writeCapabilityManifest: manifest.write,
}));

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    release,
    ready,
    wait: async () => {
      entered();
      await pending;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  manifest.read.mockReset();
  manifest.write.mockReset();
});

describe('stop during asynchronous startup', () => {
  it('keeps a tools-change notification received during capability discovery', async () => {
    const paused = gate();
    const toolRegistry = new ToolRegistry();
    const registry = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      idleTimeoutMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
    let currentTools = [{ name: 'old', inputSchema: {} }];
    let notify!: ToolsChangedListener;
    vi.spyOn(MCPClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'close').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'listTools').mockImplementation(() => currentTools);
    vi.spyOn(MCPClient.prototype, 'addToolsChangedListener').mockImplementation((listener) => {
      notify = listener;
    });
    vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue({
      protocolVersion: '2025-06-18',
      capabilities: { resources: {} },
      serverInfo: { name: 'fixture', version: '1' },
    });
    vi.spyOn(MCPClient.prototype, 'listResources').mockImplementation(async () => {
      await paused.wait();
      return { resources: [] };
    });
    vi.spyOn(MCPClient.prototype, 'listResourceTemplates').mockResolvedValue({
      resourceTemplates: [],
    });
    const startup = registry.start({ name: 'fixture', transport: 'stdio', command: 'unused' });
    try {
      await paused.ready;
      currentTools = [{ name: 'new', inputSchema: {} }];
      notify('fixture', currentTools);
      expect(registry.describeTools('fixture')?.[0]?.name).toBe('new');
      paused.release();
      await startup;
      expect(registry.describeTools('fixture')?.[0]?.name).toBe('new');
      expect(registry.list()[0]?.tools).toEqual(['mcp__fixture__new']);
    } finally {
      paused.release();
      await startup;
      await registry.stopAll();
    }
  });

  for (const phase of ['resources', 'prompts', 'manifest-write', 'manifest-read'] as const) {
    it(`does not restore tools or publish connected after stop during ${phase}`, async () => {
      const paused = gate();
      const tools = [{ name: 'echo', inputSchema: { type: 'object' } }];
      const events = new EventBus();
      const connected = vi.fn();
      events.on('mcp.server.connected', connected);
      const toolRegistry = new ToolRegistry();
      const registry = new MCPRegistry({
        toolRegistry,
        events,
        cacheDir: 'unused-mocked-cache',
        idleTimeoutMs: 0,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      });
      vi.spyOn(MCPClient.prototype, 'connect').mockResolvedValue();
      vi.spyOn(MCPClient.prototype, 'close').mockResolvedValue();
      vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue(tools);
      vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue({
        protocolVersion: '2025-06-18',
        capabilities: { resources: {}, prompts: {} },
        serverInfo: { name: 'fixture', version: '1' },
      });
      vi.spyOn(MCPClient.prototype, 'listResources').mockImplementation(async () => {
        if (phase === 'resources') await paused.wait();
        return { resources: [{ uri: 'fixture://resource', name: 'resource' }] };
      });
      vi.spyOn(MCPClient.prototype, 'listResourceTemplates').mockResolvedValue({
        resourceTemplates: [],
      });
      vi.spyOn(MCPClient.prototype, 'listPrompts').mockImplementation(async () => {
        if (phase === 'prompts') await paused.wait();
        return { prompts: [{ name: 'fixture-prompt' }] };
      });
      manifest.read.mockImplementation(async () => {
        if (phase !== 'manifest-read') return undefined;
        await paused.wait();
        return { tools, prompts: [{ name: 'cached-prompt' }] };
      });
      manifest.write.mockImplementation(async () => {
        if (phase === 'manifest-write') await paused.wait();
      });
      const startup = registry.start({
        name: 'fixture',
        transport: 'stdio',
        command: 'unused',
        lazy: true,
      });
      try {
        await paused.ready;
        await registry.stop('fixture');
        paused.release();
        await startup;
        expect(registry.list()).toEqual([
          { name: 'fixture', state: 'disconnected', toolCount: 0, tools: [] },
        ]);
        expect(toolRegistry.list()).toHaveLength(0);
        expect(connected).not.toHaveBeenCalled();
        expect(registry.getCatalog('fixture')?.prompts).toBeUndefined();
        expect(registry.getCatalog('fixture')?.resources).toBeUndefined();
        // The cancellation fence must still allow an explicit restart.
        await registry.restart('fixture');
        expect(registry.list()[0]).toEqual({
          name: 'fixture',
          state: phase === 'manifest-read' ? 'dormant' : 'connected',
          toolCount: 1,
          tools: ['mcp__fixture__echo'],
        });
        expect(toolRegistry.list()).toHaveLength(1);
        if (phase !== 'manifest-read') expect(connected).toHaveBeenCalledTimes(1);
      } finally {
        paused.release();
        await startup;
        await registry.stopAll();
      }
    });
  }
});
