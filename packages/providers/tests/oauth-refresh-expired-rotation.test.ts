import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthRefreshCoordinator,
  resetSharedOAuthRefreshState,
} from '../src/oauth-refresh-coordinator.js';

interface Tokens {
  accessToken: string;
  refreshKey: string;
  expiresAt: number;
}

function coordinator(
  key: string,
  refreshFn: (key: string) => Promise<Tokens>,
  label = 'expired rotation',
  onRefresh = vi.fn(),
) {
  const applied = vi.fn();
  return {
    applied,
    onRefresh,
    value: new OAuthRefreshCoordinator({
      label,
      initialRefreshKey: key,
      initialExpiresAt: 0,
      refreshSkewMs: 0,
      hooks: {
        refreshFn,
        projectTokens: (tokens: Tokens) => tokens,
        applyTokens: applied,
        formatPayload: (tokens: Tokens) => tokens,
        onRefresh,
      },
    }),
  };
}

beforeEach(() => {
  resetSharedOAuthRefreshState();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  resetSharedOAuthRefreshState();
  vi.useRealTimers();
});

describe('OAuth refresh successor links survive access-token expiry', () => {
  it('refreshes an expired sibling with the successor instead of replaying an invalidated key', async () => {
    let current = 'r1';
    const refresh = vi.fn(async (key: string) => {
      if (key !== current) throw new Error('invalid_grant');
      current = key === 'r1' ? 'r2' : 'r3';
      return { accessToken: current, refreshKey: current, expiresAt: Date.now() + 1000 };
    });
    const owner = coordinator('r1', refresh);
    const sibling = coordinator('r1', refresh);
    await owner.value.runRefresh();
    await coordinator('r1', refresh).value.runRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_001_001);
    await sibling.value.runRefresh();
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(['r1', 'r2']);
    expect(sibling.applied).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshKey: 'r3' }),
      expect.anything(),
    );
  });

  it('keeps an expired successor when an unrelated account records a rotation', async () => {
    await coordinator('r1', async () => ({
      accessToken: 'old',
      refreshKey: 'r2',
      expiresAt: Date.now() + 1000,
    })).value.runRefresh();
    vi.setSystemTime(1_001_000);
    await coordinator(
      'other',
      async () => ({ accessToken: 'other', refreshKey: 'other2', expiresAt: Date.now() + 1000 }),
      'other account',
    ).value.runRefresh();
    const refresh = vi.fn(async (key: string) => ({
      accessToken: 'fresh',
      refreshKey: `${key}-next`,
      expiresAt: Date.now() + 1000,
    }));
    await coordinator('r1', refresh).value.runRefresh();
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(['r2']);
  });

  it('follows more than sixteen retained rotations to the freshest token', async () => {
    let count = 1;
    const owner = coordinator('r1', async () => {
      count++;
      return { accessToken: `a${count}`, refreshKey: `r${count}`, expiresAt: Date.now() + 1000 };
    });
    for (let i = 0; i < 20; i++) await owner.value.runRefresh();
    const replay = vi.fn(async () => {
      throw new Error('must adopt latest');
    });
    const sibling = coordinator('r1', replay);
    await sibling.value.runRefresh();
    expect(replay).not.toHaveBeenCalled();
    expect(sibling.applied).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a21' }),
      expect.anything(),
    );
  });

  it('adopts a sibling token that is inside the skew window but still unexpired when the token endpoint blips', async () => {
    const owner = new OAuthRefreshCoordinator({
      label: 'skew-adoption',
      initialRefreshKey: 'r1',
      initialExpiresAt: Date.now() - 10_000,
      refreshSkewMs: 60_000,
      hooks: {
        refreshFn: async () => ({
          accessToken: 'valid-a2',
          refreshKey: 'r2',
          expiresAt: Date.now() + 30_000,
        }),
        projectTokens: (tokens: Tokens) => tokens,
        applyTokens: () => {},
        formatPayload: (tokens: Tokens) => tokens,
      },
    });
    await owner.runRefresh();

    let siblingAccess = 'expired-a1';
    const sibling = new OAuthRefreshCoordinator({
      label: 'skew-adoption',
      initialRefreshKey: 'r1',
      initialExpiresAt: Date.now() - 10_000,
      refreshSkewMs: 60_000,
      hooks: {
        refreshFn: async () => {
          throw new Error('503 transient failure');
        },
        projectTokens: (tokens: Tokens) => tokens,
        applyTokens: (derived) => {
          siblingAccess = derived.accessToken;
        },
        formatPayload: (tokens: Tokens) => tokens,
      },
    });
    await expect(sibling.ensureFreshToken(new AbortController().signal)).resolves.toBeUndefined();
    expect(siblingAccess).toBe('valid-a2');
  });

  it('compresses predecessor rotation links so an expired first hop is not evicted while its chain is still fresh', async () => {
    let step = 0;
    const leader = coordinator('r1', async (key) => {
      step++;
      if (step === 1 && key === 'r1') {
        return { accessToken: 'a2', refreshKey: 'r2', expiresAt: Date.now() - 1000 };
      }
      return { accessToken: 'a3', refreshKey: 'r3', expiresAt: Date.now() + 60_000 };
    });
    const sibling = coordinator('r1', async () => {
      throw new Error('invalid_grant');
    });
    await leader.value.runRefresh();
    await leader.value.runRefresh();
    for (let i = 0; i < 63; i++) {
      await coordinator(
        `other-${i}`,
        async (k) => ({
          accessToken: `oa-${i}`,
          refreshKey: `${k}-next`,
          expiresAt: i === 60 ? Date.now() - 500 : Date.now() + 60_000,
        }),
        `other-${i}`,
      ).value.runRefresh();
    }
    await expect(sibling.value.runRefresh()).resolves.toMatchObject({
      accessToken: 'a3',
      refreshKey: 'r3',
    });
  });
});
