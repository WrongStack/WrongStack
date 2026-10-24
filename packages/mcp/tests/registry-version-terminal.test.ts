import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPUnsupportedProtocolVersionError } from '../src/constants.js';

// Shared, hoisted counters so the mocked MCPClient can be inspected: the whole
// point of this file is counting how many times the registry TRIED to connect.
const h = vi.hoisted(() => ({
  constructed: 0,
  connectCalls: 0,
  closes: 0,
}));

vi.mock('../src/client.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeClient {
    constructor() {
      h.constructed++;
    }
    async connect(): Promise<void> {
      h.connectCalls++;
      // Deterministic refusal: retrying produces the exact same throw.
      throw new MCPUnsupportedProtocolVersionError(
        'future-server',
        '2026-07-28',
        'server answered 2026-07-28, unsupported here',
      );
    }
    listTools() {
      return [];
    }
    getServerMetadata() {
      return undefined;
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
    addResourcesChangedListener() {}
    removeResourcesChangedListener() {}
    addResourceUpdatedListener() {}
    removeResourceUpdatedListener() {}
    addPromptsChangedListener() {}
    removePromptsChangedListener() {}
  }
  return { ...actual, MCPClient: FakeClient };
});

// Import AFTER the mock so the registry binds to FakeClient.
const { MCPRegistry } = await import('../src/registry.js');

const cfg = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'never-actually-run',
  args: [],
  lazy: false,
  ...extra,
});

let toolReg: ToolRegistry;
let events: EventBus;
let errors: unknown[];
let warns: unknown[];
let log: Logger;

beforeEach(() => {
  toolReg = new ToolRegistry();
  events = new EventBus();
  errors = [];
  warns = [];
  log = {
    error: (...a: unknown[]) => errors.push(a),
    warn: (...a: unknown[]) => warns.push(a),
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => log,
  } as never as Logger;
  h.constructed = 0;
  h.connectCalls = 0;
  h.closes = 0;
});

describe('MCPRegistry protocol-version refusal is terminal', () => {
  it('stops after exactly one connect attempt', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log });
    const disconnected: Array<{ name: string; reason?: string; terminal?: boolean }> = [];
    events.on('mcp.server.disconnected', (p) =>
      disconnected.push(p as { name: string; reason?: string; terminal?: boolean }),
    );

    await reg.start(cfg('future-server'));

    // THE assertion this file exists for: MAX_ATTEMPTS is 3, and every one of
    // them would spawn a fresh stdio child for a handshake that can never
    // succeed. One attempt is the contract.
    expect(h.connectCalls).toBe(1);
    expect(h.constructed).toBe(1);

    const listed = reg.list().find((s) => s.name === 'future-server');
    expect(listed?.state).toBe('failed');
    // `attempts` lives on the internal slot, not on list()'s projection.
    const internal = (reg as never as { servers: Map<string, { attempts: number }> }).servers.get(
      'future-server',
    );
    expect(internal?.attempts).toBe(1);

    // No retry backoff was paid, and the client was closed exactly once.
    expect(h.closes).toBe(1);

    // Terminal, with the actionable reason — not a transient disconnect.
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toMatchObject({ name: 'future-server', terminal: true });
    expect(disconnected[0]?.reason).toContain('2026-07-28');

    // And it must not claim it exhausted 3 attempts when it used one.
    const logged = errors.flat().map(String).join(' ');
    expect(logged).toContain('not retrying');
    expect(logged).not.toContain('exhausted after 3 attempts');
    // No per-attempt warning either; that path is for retryable failures.
    expect(warns).toHaveLength(0);

    await reg.stopAll();
  }, 15_000);

  it('records the refusal under the protocol failure kind with a bounded reason', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log });
    await reg.start(cfg('future-server'));

    const health = reg.operationalHealth().find((s) => s.name === 'future-server');
    expect(health).toBeDefined();
    expect(health?.lastFailureKind).toBe('protocol');
    // Must be the registered code, not safeOperationReason's 'other' fallback.
    expect(health?.lastReason).toBe('unsupported-protocol-version');
    expect(health?.failures.protocol).toBe(1);
    expect(health?.failures.transport).toBe(0);

    await reg.stopAll();
  }, 15_000);

  it('does not schedule a reconnect cycle for the refused slot', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log });
    await reg.start(cfg('future-server'));

    const slot = (reg as never as { servers: Map<string, Record<string, unknown>> }).servers.get(
      'future-server',
    );
    expect(slot?.['reconnectTimer']).toBeUndefined();
    expect(slot?.['reconnectPending']).toBe(false);
    expect(slot?.['reconnectCycles']).toBe(0);

    // A demand-wake is operator intent, so it may try again — but it too must
    // give up after a single attempt rather than burning the full loop.
    h.connectCalls = 0;
    // The wake wrapper rethrows the slot's typed refusal, so the caller sees
    // the refused revision instead of a generic message.
    const wake = reg.ensureConnected('future-server');
    await expect(wake).rejects.toBeInstanceOf(MCPUnsupportedProtocolVersionError);
    await expect(wake).rejects.toThrow(/2026-07-28/);
    expect(h.connectCalls).toBe(1);

    await reg.stopAll();
  }, 15_000);
});
