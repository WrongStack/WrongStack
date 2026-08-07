import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The WebUI copy of the `features.mailboxBridge` gate.
 *
 * `discoverMailboxBridgeForWebui` spawns a detached `wstack mailbox
 * serve` when it finds no live lock, so an accidental default flip here
 * costs a ~130 MB CLI process per WebUI project — the same regression
 * the CLI-side gate test guards. The two defaults must stay in lockstep;
 * a WebUI that still defaults to 'auto' would keep the bridge alive for
 * a user who turned it off everywhere else.
 */

const readLiveLock = vi.fn(async () => ({ kind: 'absent' as const }));

vi.mock('@wrongstack/core/coordination', () => ({
  readLiveLock: (...args: unknown[]) =>
    (readLiveLock as unknown as (...a: unknown[]) => unknown)(...args),
  resolveProjectDir: (root: string) => root,
}));

vi.mock('@wrongstack/core/utils', () => ({
  wstackGlobalRoot: () => '/tmp/wstack-global-root',
}));

const spawn = vi.fn(() => {
  throw new Error('spawn must not be reached when the bridge gate is off');
});

vi.mock('node:child_process', () => ({ spawn }));

const { discoverMailboxBridgeForWebui } = await import('../src/server/discover-mailbox-bridge.js');

function stubLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  readLiveLock.mockClear();
  spawn.mockClear();
});

describe('discoverMailboxBridgeForWebui gating', () => {
  it('returns without probing or spawning when mailboxBridge is unset (default off)', async () => {
    const ctx = { meta: {} as Record<string, unknown> };
    await discoverMailboxBridgeForWebui({
      projectRoot: '/tmp/project-root',
      config: { features: {} },
      logger: stubLogger(),
      ctx,
    });

    expect(readLiveLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.meta['mailboxBridge']).toBeUndefined();
  });

  it('returns without probing when the whole config is absent', async () => {
    const ctx = { meta: {} as Record<string, unknown> };
    await discoverMailboxBridgeForWebui({
      projectRoot: '/tmp/project-root',
      config: undefined,
      logger: stubLogger(),
      ctx,
    });

    expect(readLiveLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("probes for an existing bridge when explicitly opted in with 'auto'", async () => {
    const ctx = { meta: {} as Record<string, unknown> };
    readLiveLock.mockResolvedValueOnce({
      kind: 'live',
      lock: { url: 'http://127.0.0.1:7788', token: 'tok' },
    } as never);

    await discoverMailboxBridgeForWebui({
      projectRoot: '/tmp/project-root',
      config: { features: { mailboxBridge: 'auto' } },
      logger: stubLogger(),
      ctx,
    });

    expect(readLiveLock).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.meta['mailboxBridge']).toMatchObject({
      url: 'http://127.0.0.1:7788',
      token: 'tok',
      source: 'joined',
    });
  });
});
