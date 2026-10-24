import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';
import type { MCPRegistryInternals } from '../src/registry-internals.js';
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

afterEach(() => vi.useRealTimers());

describe('registry disconnect callback ownership', () => {
  for (const kind of ['child', 'http'] as const) {
    it.each([
      { lazy: false, phase: 'failure' },
      { lazy: false, phase: 'disconnected' },
      { lazy: true, phase: 'failure' },
    ] as const)(
      `${kind}: honors stop from $phase callback (lazy=$lazy)`,
      async ({ lazy, phase }) => {
        vi.useFakeTimers();
        const events = new EventBus();
        const registry = new MCPRegistry({
          toolRegistry: new ToolRegistry(),
          events,
          idleTimeoutMs: 0,
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          } as unknown as Logger,
        });
        const self = registry as unknown as MCPRegistryInternals;
        const closing = gate();
        const client = new MCPClient({ name: 'fixture', transport: 'stdio', command: 'unused' });
        client.close = () => closing.wait();
        const slot: ServerSlot = {
          cfg: { name: 'fixture', transport: 'stdio', command: 'unused' },
          client,
          state: 'connected',
          toolNames: [],
          lazyTools: [],
          attempts: 0,
          reconnectPending: false,
          reconnectCycles: 0,
          lazy,
          lastUsed: 0,
          registeredLazy: false,
          operations: createMCPServerOperationState(),
        };
        self.servers.set('fixture', slot);
        let stopping: Promise<void> | undefined;
        const automaticReason = kind === 'child' ? 'exit:1' : 'http-disconnect';
        const reasons: string[] = [];
        registry.onOperation((event) => {
          if (phase === 'failure' && event.kind === 'failure') stopping = registry.stop('fixture');
        });
        events.on('mcp.server.disconnected', (event) => {
          reasons.push(event.reason);
          if (phase === 'disconnected' && event.reason === automaticReason)
            stopping = registry.stop('fixture');
        });
        try {
          if (kind === 'child') self.onChildExit('fixture', 1, null);
          else self.onTransportDisconnect('fixture');
          await closing.ready;
          expect(slot.state).toBe('disconnected');
          expect(slot.reconnectPending).toBe(false);
          expect(slot.reconnectTimer).toBeUndefined();
          expect(reasons.filter((reason) => reason.startsWith(automaticReason))).toHaveLength(
            phase === 'failure' ? 0 : 1,
          );
          closing.release();
          await stopping;
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          closing.release();
          await stopping;
          await registry.stopAll();
        }
      },
    );
  }
});
