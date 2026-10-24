import { ToolValidationError } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Drive guardedLookup (the undici dispatcher's DNS callback) and the
// assertNotPrivate resolved-private rethrow with a mocked resolver — real fetch
// never exercises these because the dispatcher's lookup only runs on a live
// connection.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', async (orig) => ({
  ...(await orig<typeof import('node:dns/promises')>()),
  lookup: (...a: unknown[]) => lookupMock(...a),
  default: { lookup: (...a: unknown[]) => lookupMock(...a) },
}));

import { assertNotPrivate } from '../src/_fetch-guard.js';
import { fetchTool, guardedLookup } from '../src/fetch.js';
import { mkSandbox, newSignal } from './fixtures.js';

afterEach(() => {
  lookupMock.mockReset();
  vi.restoreAllMocks();
});

const call = (
  hostname: string,
  options: { all?: boolean; family?: number },
): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }> =>
  new Promise((resolve) => {
    guardedLookup(hostname, options, (err, address, family) =>
      resolve({
        err,
        ...(address !== undefined ? { address } : {}),
        ...(family !== undefined ? { family } : {}),
      }),
    );
  });

describe('guardedLookup', () => {
  it('returns the full address list when options.all is set', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const { err, address } = await call('example.com', { all: true });
    expect(err).toBeNull();
    expect(Array.isArray(address)).toBe(true);
    expect((address as unknown[]).length).toBe(2);
  });

  it('returns a single address when options.all is not set', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { err, address, family } = await call('example.com', {});
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('filters by requested address family', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 },
    ]);
    const { address, family } = await call('example.com', { family: 6 });
    expect(address).toBe('2606:2800::1');
    expect(family).toBe(6);
  });

  it('rejects when a resolved address is private (anti-rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const { err } = await call('rebind.example', { all: true });
    expect(err?.message).toMatch(/private address/);
    expect(err?.code).toBe('EAI_FAIL');
  });

  it('rejects an IPv6 private resolution', async () => {
    lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
    const { err } = await call('rebind6.example', { all: true });
    expect(err?.message).toMatch(/private address/);
  });

  it('returns ENOTFOUND when no address is resolved', async () => {
    lookupMock.mockResolvedValue([]);
    const { err } = await call('empty.example', {});
    expect(err?.code).toBe('ENOTFOUND');
  });

  it('forwards a DNS resolution failure', async () => {
    lookupMock.mockImplementation(async () => {
      throw Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' });
    });
    const { err } = await call('broken.example', { all: true });
    expect(err?.message).toMatch(/getaddrinfo/);
  });
});

describe('assertNotPrivate via fetchTool', () => {
  it('keeps private-address blocks typed rather than coupled to their message', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);

    await expect(assertNotPrivate('internal.example')).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects a hostname that resolves to a private address (pre-flight)', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'https://internal.example/' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/private address/);
    } finally {
      await sb.cleanup();
    }
  });
});
