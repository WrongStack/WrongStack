import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';
import type { ServerSlot } from '../src/registry-slots.js';

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    ready,
    release,
    wait: async () => {
      enter();
      await pending;
    },
  };
}

function fixture() {
  const toolRegistry = new ToolRegistry();
  const registry = new MCPRegistry({
    toolRegistry,
    events: new EventBus(),
    idleTimeoutMs: 10,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  });
  const client = new MCPClient({ name: 'fixture', transport: 'stdio', command: 'unused' });
  vi.spyOn(client, 'getServerMetadata').mockReturnValue({
    protocolVersion: '2025-06-18',
    capabilities: { resources: { subscribe: true }, prompts: {} },
    serverInfo: { name: 'fixture', version: '1' },
  });
  const close = vi.spyOn(client, 'close').mockResolvedValue();
  const slot: ServerSlot = {
    cfg: { name: 'fixture', transport: 'stdio', command: 'unused' },
    client,
    state: 'connected',
    lazy: true,
    toolNames: [],
    lazyTools: [],
    attempts: 0,
    reconnectPending: false,
    reconnectCycles: 0,
    registeredLazy: false,
    lastUsed: Date.now(),
    operations: createMCPServerOperationState(),
  };
  const internals = registry as unknown as {
    servers: Map<string, ServerSlot>;
    sweepIdle(): Promise<void>;
  };
  internals.servers.set('fixture', slot);
  return { registry, client, slot, close, internals, toolRegistry };
}

afterEach(() => vi.restoreAllMocks());

describe('capability request lifecycle', () => {
  for (const lazy of [true, false]) {
    it(`uses an updated output schema when only outputSchema changes (lazy=${lazy})`, async () => {
      const { registry, client, slot, toolRegistry } = fixture();
      slot.lazy = lazy;
      vi.spyOn(client, 'callTool').mockResolvedValue({
        content: 'ok',
        isError: false,
        structuredContent: { newRequired: 'value' },
      });
      const apply = (
        registry as unknown as {
          applyTools(
            slot: ServerSlot,
            tools: import('../src/contracts.js').MCPTool[],
            client: MCPClient,
          ): void;
        }
      ).applyTools.bind(registry);
      const base = { name: 'schema', inputSchema: {} };
      try {
        apply(
          slot,
          [{ ...base, outputSchema: { type: 'object', required: ['oldRequired'] } }],
          client,
        );
        apply(
          slot,
          [{ ...base, outputSchema: { type: 'object', required: ['newRequired'] } }],
          client,
        );
        const tool = toolRegistry.list()[0];
        const output = await tool?.execute({}, {} as never, {} as never);
        expect(output).not.toContain('does not match');
      } finally {
        await registry.stopAll();
      }
    });
  }

  it('does not invalidate resource templates when resources refresh concurrently', async () => {
    const { registry, client, slot } = fixture();
    const paused = gate();
    vi.spyOn(client, 'listResourceTemplates').mockImplementation(async () => {
      await paused.wait();
      return { resourceTemplates: [{ name: 'template', uriTemplate: 'fixture://{id}' }] };
    });
    vi.spyOn(client, 'listResources').mockResolvedValue({
      resources: [{ name: 'resource', uri: 'fixture://resource' }],
    });
    const pending = registry.listResourceTemplates('fixture', { refresh: true });
    try {
      await paused.ready;
      await registry.listResources('fixture', { refresh: true });
      paused.release();
      await pending;
      expect(slot.resources?.[0]?.name).toBe('resource');
      expect(slot.resourceTemplates?.[0]?.name).toBe('template');
    } finally {
      paused.release();
      await pending;
      await registry.stopAll();
    }
  });

  it('preserves the known catalog if the newest refresh fails', async () => {
    const { registry, client, slot } = fixture();
    slot.resources = [{ name: 'known', uri: 'fixture://known' }];
    const paused = gate();
    vi.spyOn(client, 'listResources')
      .mockImplementationOnce(async () => {
        await paused.wait();
        return { resources: [{ name: 'old', uri: 'fixture://old' }] };
      })
      .mockRejectedValueOnce(new Error('fixture failure'));
    const pending = registry.listResources('fixture', { refresh: true });
    try {
      await paused.ready;
      await expect(registry.listResources('fixture', { refresh: true })).rejects.toThrow(
        'fixture failure',
      );
      paused.release();
      await pending;
      expect(slot.resources?.[0]?.name).toBe('known');
    } finally {
      paused.release();
      await pending;
      await registry.stopAll();
    }
  });

  for (const operation of ['listResources', 'listResourceTemplates', 'listPrompts'] as const) {
    const field =
      operation === 'listResources'
        ? 'resources'
        : operation === 'listResourceTemplates'
          ? 'resourceTemplates'
          : 'prompts';
    const page = (name: string) => ({
      resources: [{ uri: `fixture://${name}`, name }],
      resourceTemplates: [{ uriTemplate: `fixture://${name}/{id}`, name }],
      prompts: [{ name }],
    });

    it(`${operation}: older refresh completion cannot replace the newest catalog`, async () => {
      const { registry, client, slot } = fixture();
      const paused = gate();
      vi.spyOn(client, operation)
        .mockImplementationOnce(async () => {
          await paused.wait();
          return page('old') as never;
        })
        .mockResolvedValueOnce(page('new') as never);
      const first = registry[operation]('fixture', { refresh: true });
      try {
        await paused.ready;
        await registry[operation]('fixture', { refresh: true });
        paused.release();
        await first;
        expect(slot[field]?.[0]?.name).toBe('new');
      } finally {
        paused.release();
        await first.catch(() => undefined);
        await registry.stopAll();
      }
    });

    it(`${operation}: list-change invalidation wins over an older refresh`, async () => {
      const { registry, client, slot } = fixture();
      const paused = gate();
      vi.spyOn(client, operation).mockImplementation(async () => {
        await paused.wait();
        return page('old') as never;
      });
      const pending = registry[operation]('fixture', { refresh: true });
      try {
        await paused.ready;
        const callbacks = registry as unknown as {
          onResourcesChanged(name: string): void;
          onPromptsChanged(name: string): void;
        };
        if (field === 'prompts') callbacks.onPromptsChanged('fixture');
        else callbacks.onResourcesChanged('fixture');
        paused.release();
        await pending;
        expect(slot[field]).toBeUndefined();
      } finally {
        paused.release();
        await pending.catch(() => undefined);
        await registry.stopAll();
      }
    });
  }

  it('releases activity accounting when a capability request fails', async () => {
    const { registry, client, slot, close, internals } = fixture();
    vi.spyOn(client, 'readResource').mockRejectedValue(new Error('fixture failure'));
    try {
      await expect(registry.readResource('fixture', 'fixture://resource')).rejects.toThrow(
        'fixture failure',
      );
      expect(slot.operations.inFlightCalls).toBe(0);
      expect(slot.operations.peakInFlightCalls).toBe(1);
      slot.lastUsed = Date.now() - 100;
      await internals.sweepIdle();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await registry.stopAll();
    }
  });

  it('releases activity accounting when waking the client fails', async () => {
    const { registry, slot } = fixture();
    vi.spyOn(registry, 'ensureConnected').mockRejectedValue(new Error('wake failed'));
    try {
      await expect(registry.getPrompt('fixture', 'prompt')).rejects.toThrow('wake failed');
      expect(slot.operations.inFlightCalls).toBe(0);
    } finally {
      await registry.stopAll();
    }
  });

  for (const operation of [
    'readResource',
    'getPrompt',
    'listResources',
    'listResourceTemplates',
    'listPrompts',
    'subscribeResource',
    'unsubscribeResource',
  ] as const) {
    it(`keeps a lazy server awake during ${operation} and releases it afterward`, async () => {
      const { registry, client, slot, close, internals } = fixture();
      const paused = gate();
      const request = vi.spyOn(client, operation).mockImplementation(async () => {
        await paused.wait();
        return {
          contents: [],
          messages: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        } as never;
      });
      const pending =
        operation === 'getPrompt'
          ? registry.getPrompt('fixture', 'prompt')
          : operation === 'readResource' ||
              operation === 'subscribeResource' ||
              operation === 'unsubscribeResource'
            ? registry[operation]('fixture', 'fixture://resource')
            : registry[operation]('fixture', { refresh: true });
      try {
        await paused.ready;
        slot.lastUsed = Date.now() - 100;
        await internals.sweepIdle();
        expect(close).not.toHaveBeenCalled();
        expect(slot.state).toBe('connected');
        await expect(registry.sleep('fixture')).rejects.toThrow(/in flight/);
        paused.release();
        await pending;
        expect(slot.operations.inFlightCalls).toBe(0);
        expect(slot.lastUsed).toBeGreaterThan(Date.now() - 100);
        slot.lastUsed = Date.now() - 100;
        await internals.sweepIdle();
        expect(close).toHaveBeenCalledTimes(1);
        expect(slot.state).toBe('dormant');
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        paused.release();
        await pending;
        await registry.stopAll();
      }
    });
  }

  for (const operation of ['listResources', 'listResourceTemplates', 'listPrompts'] as const) {
    it(`does not restore a stopped catalog when ${operation} finishes late`, async () => {
      const { registry, client } = fixture();
      const paused = gate();
      vi.spyOn(client, operation).mockImplementation(async () => {
        await paused.wait();
        return {
          resources: [{ uri: 'fixture://late', name: 'late' }],
          resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'late' }],
          prompts: [{ name: 'late' }],
        } as never;
      });
      const pending = registry[operation]('fixture', { refresh: true });
      try {
        await paused.ready;
        await registry.stop('fixture');
        paused.release();
        await expect(pending).rejects.toThrow(/changed|stopped|disconnected/);
        const catalog = registry.getCatalog('fixture');
        expect(catalog?.resources).toBeUndefined();
        expect(catalog?.resourceTemplates).toBeUndefined();
        expect(catalog?.prompts).toBeUndefined();
      } finally {
        paused.release();
        await pending.catch(() => undefined);
        await registry.stopAll();
      }
    });
  }
});
