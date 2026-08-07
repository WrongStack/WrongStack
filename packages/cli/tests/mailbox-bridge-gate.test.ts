import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the `features.mailboxBridge` GATE in
 * `bootstrapMailboxBridgeAtStartup` — as opposed to
 * `mailbox-bridge-bootstrap.test.ts`, which drives the underlying
 * `tryAcquireMailboxBridge` helper directly and bypasses the gate.
 *
 * The default is the whole point of this file. The bridge is a loopback
 * HTTP façade for EXTERNAL agents; no WrongStack-internal surface reads
 * the handle it stashes on `ctx.meta`. Defaulting it on cost every user
 * a detached `wstack mailbox serve` CLI process (~130 MB resident, no
 * idle shutdown) per project in exchange for nothing, so the default is
 * 'off' and 'auto' is opt-in. A silent flip back would be invisible
 * except as RAM, which is exactly why it is pinned here.
 */

const tryAcquire = vi.fn(async () => ({
  url: 'http://127.0.0.1:7788',
  token: 'tok',
  lockPath: '/tmp/lock',
  childPid: 4242,
  source: 'spawned' as const,
}));

vi.mock('../src/mailbox-bridge-bootstrap.js', () => ({
  tryAcquireMailboxBridge: (...args: unknown[]) =>
    (tryAcquire as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { bootstrapMailboxBridgeAtStartup, MAILBOX_BRIDGE_META_KEY } = await import(
  '../src/wiring/mailbox-bridge-bootstrap.js'
);

function stubLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('@wrongstack/core/types').Logger;
}

beforeEach(() => {
  tryAcquire.mockClear();
});

describe('bootstrapMailboxBridgeAtStartup gating', () => {
  it('does not acquire a bridge when features.mailboxBridge is unset (default off)', async () => {
    const ctx = { meta: {} as Record<string, unknown> };
    const handle = await bootstrapMailboxBridgeAtStartup({
      projectRoot: process.cwd(),
      config: { features: {} },
      logger: stubLogger(),
      source: 'cli',
      ctx,
    });

    expect(tryAcquire).not.toHaveBeenCalled();
    expect(handle).toBeNull();
    expect(ctx.meta[MAILBOX_BRIDGE_META_KEY]).toBeUndefined();
  });

  it('does not acquire a bridge when the whole config is absent', async () => {
    const handle = await bootstrapMailboxBridgeAtStartup({
      projectRoot: process.cwd(),
      config: undefined,
      logger: stubLogger(),
      source: 'webui',
    });

    expect(tryAcquire).not.toHaveBeenCalled();
    expect(handle).toBeNull();
  });

  it("does not acquire a bridge when explicitly 'off'", async () => {
    const handle = await bootstrapMailboxBridgeAtStartup({
      projectRoot: process.cwd(),
      config: { features: { mailboxBridge: 'off' } },
      logger: stubLogger(),
      source: 'eternal',
    });

    expect(tryAcquire).not.toHaveBeenCalled();
    expect(handle).toBeNull();
  });

  it("acquires and stashes the handle when explicitly opted in with 'auto'", async () => {
    const ctx = { meta: {} as Record<string, unknown> };
    const handle = await bootstrapMailboxBridgeAtStartup({
      projectRoot: process.cwd(),
      config: { features: { mailboxBridge: 'auto' } },
      logger: stubLogger(),
      source: 'cli',
      ctx,
    });

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(handle?.source).toBe('spawned');
    expect(ctx.meta[MAILBOX_BRIDGE_META_KEY]).toBe(handle);
  });
});
