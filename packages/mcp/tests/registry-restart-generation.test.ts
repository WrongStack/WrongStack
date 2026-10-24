import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { MCPRegistry } from '../src/registry.js';

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('restart supersedes an in-flight connection', () => {
  for (const outcome of ['success', 'failure'] as const) {
    it(`keeps the replacement single-flight when the old handshake finishes with ${outcome}`, async () => {
      vi.useFakeTimers();
      const old = gate();
      const next = gate();
      const registry = new MCPRegistry({
        toolRegistry: new ToolRegistry(),
        events: new EventBus(),
        idleTimeoutMs: 0,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      });
      const connect = vi.spyOn(MCPClient.prototype, 'connect').mockImplementation(async function (
        this: MCPClient,
      ) {
        if (this.opts.command === 'old') {
          await old.wait();
          if (outcome === 'failure') throw new Error('superseded handshake failed');
        } else {
          await next.wait();
        }
      });
      const close = vi.spyOn(MCPClient.prototype, 'close').mockResolvedValue();
      vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue([]);
      vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue(undefined);
      const cfg = { name: 'fixture', transport: 'stdio' as const, command: 'old' };
      const startup = registry.start(cfg);
      await old.ready;
      const restarting = registry.restart('fixture', { ...cfg, command: 'next' });
      await next.ready;
      try {
        old.release();
        await vi.advanceTimersByTimeAsync(1000);
        const demand = registry.ensureConnected('fixture');
        next.release();
        const [, client] = await Promise.all([restarting, demand]);
        await startup;
        expect(client.opts.command).toBe('next');
        expect(connect).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(1);
        expect(registry.health()).toEqual([{ name: 'fixture', alive: true }]);
        expect(registry.operationalHealth()[0]?.consecutiveFailures).toBe(0);
      } finally {
        old.release();
        next.release();
        await Promise.allSettled([startup, restarting]);
        await registry.stopAll();
      }
    });
  }

  it('does not replace the new client when the old handshake succeeds last', async () => {
    const old = gate();
    const registry = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events: new EventBus(),
      idleTimeoutMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
    vi.spyOn(MCPClient.prototype, 'connect').mockImplementation(async function (this: MCPClient) {
      if (this.opts.command === 'old') await old.wait();
    });
    const close = vi.spyOn(MCPClient.prototype, 'close').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue([]);
    vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue(undefined);
    const cfg = { name: 'fixture', transport: 'stdio' as const, command: 'old' };
    const startup = registry.start(cfg);
    try {
      await old.ready;
      await registry.restart('fixture', { ...cfg, command: 'next' });
      const replacement = await registry.ensureConnected('fixture');
      old.release();
      await startup;
      expect(await registry.ensureConnected('fixture')).toBe(replacement);
      expect(close.mock.instances).not.toContain(replacement);
    } finally {
      old.release();
      await startup;
      await registry.stopAll();
    }
  });
});
