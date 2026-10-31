import {
  getAllProviderQuota,
  recordProviderQuota,
  resetProviderQuota,
} from '@wrongstack/core/quota';
import { reportWrongForgeQuota } from '@wrongstack/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';

let id = 0;
const endpoint = () => ({ url: `http://wrongforge.test/${++id}`, apiKey: 'wf-test-0123456789' });
const body = {
  five_hour: { percent: 18, resetsAt: '2026-10-16T13:30:00+03:00', isActive: true },
  weekly: { percent: 0, resetsAt: '2026-10-16T20:00:00+03:00', isActive: false },
  extra_usage: { enabled: false },
};
afterEach(() => resetProviderQuota());

describe('WrongForge account quota', () => {
  it('still performs a forced read when a cached background read is already in flight', async () => {
    const ep = endpoint();
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn((url: unknown) =>
      String(url).includes('force=1')
        ? Promise.resolve(Response.json({ five_hour: { percent: 19 } }))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    const opts = { endpoint: ep, fetchImpl: fetchImpl as typeof fetch };
    const background = reportWrongForgeQuota(opts);
    const manual = reportWrongForgeQuota({ ...opts, force: true });
    release(Response.json(body));
    expect(await background).toBe(true);
    expect(await manual).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getAllProviderQuota()[0]?.windows[0]?.usedPercent).toBe(19);
  });
  it('records both windows, exact zero, reset seconds and extra-usage availability', async () => {
    const ep = endpoint();
    const fetchImpl = vi.fn(async () => Response.json(body));
    expect(
      await reportWrongForgeQuota({ endpoint: ep, fetchImpl: fetchImpl as typeof fetch }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ep.url}/v1/usage`,
      expect.objectContaining({ headers: { authorization: `Bearer ${ep.apiKey}` } }),
    );
    expect(getAllProviderQuota()).toMatchObject([
      {
        providerId: 'wrongforge',
        meterId: 'default',
        windows: [
          {
            id: 'primary',
            usedPercent: 18,
            windowMinutes: 300,
            resetsAt: Date.parse(body.five_hour.resetsAt) / 1000,
          },
          { id: 'secondary', usedPercent: 0, windowMinutes: 10080 },
        ],
        credits: { hasCredits: false, unlimited: false },
      },
    ]);
  });
  it('coalesces concurrent reads, throttles background refreshes and bypasses cache on force', async () => {
    const ep = endpoint();
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const opts = { endpoint: ep, fetchImpl: fetchImpl as typeof fetch };
    const first = reportWrongForgeQuota(opts);
    const second = reportWrongForgeQuota(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(Response.json(body));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await reportWrongForgeQuota(opts)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const forced = reportWrongForgeQuota({ ...opts, force: true });
    release(Response.json(body));
    expect(await forced).toBe(true);
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(`${ep.url}/v1/usage?force=1`, expect.anything());
  });
  it.each([502, 401])(
    'keeps the last reading when the account endpoint returns %s',
    async (status) => {
      recordProviderQuota('wrongforge', [
        {
          providerId: 'wrongforge',
          meterId: 'default',
          windows: [{ id: 'primary', usedPercent: 40 }],
          capturedAt: Date.now(),
        },
      ]);
      const before = getAllProviderQuota();
      expect(
        await reportWrongForgeQuota({
          endpoint: endpoint(),
          fetchImpl: (async () => Response.json({ error: {} }, { status })) as typeof fetch,
        }),
      ).toBe(false);
      expect(getAllProviderQuota()).toEqual(before);
    },
  );
  it('does not turn malformed readings into a zero quota', async () => {
    expect(
      await reportWrongForgeQuota({
        endpoint: endpoint(),
        fetchImpl: (async () =>
          Response.json({ five_hour: { percent: -1 }, weekly: { percent: '0' } })) as typeof fetch,
      }),
    ).toBe(false);
    expect(getAllProviderQuota()).toEqual([]);
  });
  it('records credits and the last reopening exhausted window under the selected provider id', async () => {
    expect(
      await reportWrongForgeQuota({
        endpoint: endpoint(),
        providerId: 'my-wrongforge',
        fetchImpl: (async () =>
          Response.json({
            five_hour: { percent: 100, resetsAt: '2099-01-01T01:00:00Z' },
            weekly: { percent: 100, resetsAt: '2099-01-08T01:00:00Z' },
            extra_usage: { enabled: true, usedCredits: 25, monthlyLimit: 100 },
          })) as typeof fetch,
      }),
    ).toBe(true);
    expect(getAllProviderQuota()).toMatchObject([
      {
        providerId: 'my-wrongforge',
        reachedWindowId: 'secondary',
        credits: { hasCredits: true, balance: '75 credits remaining (25/100)' },
      },
    ]);
  });
});
