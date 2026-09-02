import { describe, expect, it, vi } from 'vitest';
import { OAuthRefreshCoordinator } from '../src/oauth-refresh-coordinator.js';

interface TestTokens {
  access: string;
  refresh: string;
  expires: number;
}

function makeCoordinator(opts: {
  initialRefresh?: string;
  initialExpiresAt?: number;
  onRefresh?: (p: { accessToken: string; refreshToken: string; expiresAt: number }) => void;
  refreshFn?: (key: string, signal?: AbortSignal) => Promise<TestTokens>;
  // The host provides these to project the upstream tokens shape into the
  // coordinator's normalized {accessToken, expiresAt, refreshKey?} form.
  refreshKeyReturns?: (t: TestTokens) => string | undefined; // undefined = no rotation
  // Simulate hosts that need to mutate additional host state on refresh
  // (e.g. account-id re-derivation).
  applyExtra?: (accessToken: string) => void;
  label?: string;
  skew?: number;
}): {
  coordinator: OAuthRefreshCoordinator<
    TestTokens,
    { accessToken: string; refreshToken: string; expiresAt: number }
  >;
  applyExtraCallsRef: { value: number };
} {
  // Pass-through: undefined stays undefined so the coordinator treats it as
  // "no refresh key available" (vs the helper's default of 'r1').
  const refreshFn =
    opts.refreshFn ??
    (async (key: string) => ({
      access: `acc-${key}`,
      refresh: `ref-${key}-rotated`,
      expires: Date.now() + 3_600_000,
    }));
  const applyExtraCallsRef = { value: 0 };
  const coordinator = new OAuthRefreshCoordinator<
    TestTokens,
    { accessToken: string; refreshToken: string; expiresAt: number }
  >({
    initialRefreshKey: opts.initialRefresh,
    initialExpiresAt: opts.initialExpiresAt,
    label: opts.label ?? 'Test OAuth',
    refreshSkewMs: opts.skew,
    hooks: {
      refreshFn,
      onRefresh: opts.onRefresh,
      formatPayload: (_tokens, derived) => ({
        accessToken: derived.accessToken,
        refreshToken: derived.refreshKey ?? '',
        expiresAt: derived.expiresAt,
      }),
      projectTokens: (tokens) => ({
        accessToken: tokens.access,
        expiresAt: tokens.expires,
        refreshKey: opts.refreshKeyReturns ? opts.refreshKeyReturns(tokens) : tokens.refresh,
      }),
      applyTokens: (derived) => {
        if (opts.applyExtra) {
          opts.applyExtra(derived.accessToken);
          applyExtraCallsRef.value++;
        }
      },
    },
  });
  return {
    coordinator,
    applyExtraCallsRef,
  };
}

describe('OAuthRefreshCoordinator', () => {
  describe('isStale', () => {
    it('treats a token with no recorded expiry as stale', () => {
      const { coordinator } = makeCoordinator({ initialExpiresAt: undefined });
      expect(coordinator.isStale()).toBe(true);
    });

    it('treats a token expiring within the skew window as stale', () => {
      const skew = 60_000;
      const now = Date.now();
      const { coordinator } = makeCoordinator({
        initialExpiresAt: now + skew - 1, // 1 ms inside the skew window
        skew,
      });
      expect(coordinator.isStale()).toBe(true);
    });

    it('treats a token expiring well past the skew window as fresh', () => {
      const { coordinator } = makeCoordinator({
        initialExpiresAt: Date.now() + 3_600_000,
      });
      expect(coordinator.isStale()).toBe(false);
    });
  });

  describe('ensureFreshToken', () => {
    it('does nothing when no refresh key is configured', async () => {
      const refreshFn = vi.fn();
      const { coordinator } = makeCoordinator({ initialRefresh: undefined, refreshFn });
      await coordinator.ensureFreshToken(new AbortController().signal);
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('does nothing when the token is fresh', async () => {
      const refreshFn = vi.fn();
      const { coordinator } = makeCoordinator({
        initialExpiresAt: Date.now() + 3_600_000,
        refreshFn,
      });
      await coordinator.ensureFreshToken(new AbortController().signal);
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('refreshes when the token is stale (expired or near-expiry)', async () => {
      const refreshFn = vi.fn(async () => ({
        access: 'new',
        refresh: 'rotated',
        expires: Date.now() + 3_600_000,
      }));
      const { coordinator } = makeCoordinator({
        initialRefresh: 'r1',
        initialExpiresAt: Date.now() - 1000,
        refreshFn,
      });
      await coordinator.ensureFreshToken(new AbortController().signal);
      expect(refreshFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('single-flight', () => {
    it('coalesces concurrent doRefresh calls into one upstream call', async () => {
      let resolveRefresh!: (v: TestTokens) => void;
      const refreshFn = vi.fn(
        () =>
          new Promise<TestTokens>((r) => {
            resolveRefresh = r;
          }),
      );
      const onRefresh = vi.fn();
      const { coordinator } = makeCoordinator({ initialRefresh: 'r1', refreshFn, onRefresh });

      // Fire 5 concurrent refresh requests
      const p1 = coordinator.doRefresh(new AbortController().signal);
      const p2 = coordinator.doRefresh(new AbortController().signal);
      const p3 = coordinator.doRefresh(new AbortController().signal);
      const p4 = coordinator.ensureFreshToken(new AbortController().signal);
      const p5 = coordinator.runRefresh(new AbortController().signal);

      // Single upstream call should be in flight
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(coordinator.isStale()).toBe(true); // not yet refreshed

      // All callers share the same in-flight promise
      resolveRefresh({ access: 'acc', refresh: 'ref', expires: Date.now() + 3_600_000 });
      await Promise.all([p1, p2, p3, p4, p5]);

      expect(refreshFn).toHaveBeenCalledTimes(1);
      // onRefresh fires once per actual refresh
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('rejects concurrent awaiters when refreshFn throws', async () => {
      const refreshFn = vi.fn(async () => {
        throw new Error('upstream 503');
      });
      const { coordinator } = makeCoordinator({ initialRefresh: 'r1', refreshFn });

      const p1 = coordinator.runRefresh(new AbortController().signal);
      const p2 = coordinator.runRefresh(new AbortController().signal);

      await expect(p1).rejects.toThrow(/upstream 503/);
      await expect(p2).rejects.toThrow(/upstream 503/);

      // The slot must clear on rejection so a later retry can fire.
      expect(coordinator.isStale()).toBe(true);
      const refreshFn2 = vi.fn(async () => ({
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3_600_000,
      }));
      const { coordinator: c2 } = makeCoordinator({ initialRefresh: 'r1', refreshFn: refreshFn2 });
      await c2.doRefresh(new AbortController().signal);
      expect(refreshFn2).toHaveBeenCalledTimes(1);
    });

    it('throws a labeled error when the refresh key is missing', async () => {
      const { coordinator } = makeCoordinator({
        initialRefresh: undefined,
        label: 'My Custom OAuth',
      });
      await expect(coordinator.runRefresh(new AbortController().signal)).rejects.toThrow(
        /My Custom OAuth: refresh key missing/,
      );
    });
  });

  describe('token rotation', () => {
    it('persists the rotated refresh key back into the host state', async () => {
      // Host semantics: the refresh key rotates on every refresh (Codex-style).
      const keys: string[] = [];
      const { coordinator } = makeCoordinator({
        initialRefresh: 'r1',
        refreshFn: async (key) => {
          keys.push(key);
          return {
            access: `acc-${keys.length}`,
            refresh: `r${keys.length + 1}`,
            expires: Date.now() + 3_600_000,
          };
        },
        refreshKeyReturns: (t) => t.refresh, // rotates
      });
      await coordinator.runRefresh(new AbortController().signal);
      await coordinator.runRefresh(new AbortController().signal);
      expect(keys).toEqual(['r1', 'r2']);
    });

    it('propagates the rotated refresh key into the onRefresh payload', async () => {
      const onRefresh = vi.fn();
      const { coordinator } = makeCoordinator({
        initialRefresh: 'r1',
        refreshFn: async () => ({
          access: 'acc-2',
          refresh: 'rotated-refresh',
          expires: Date.now() + 3_600_000,
        }),
        refreshKeyReturns: (t) => t.refresh, // rotates
        onRefresh,
      });
      await coordinator.runRefresh(new AbortController().signal);
      expect(onRefresh).toHaveBeenCalledWith({
        accessToken: 'acc-2',
        refreshToken: 'rotated-refresh',
        expiresAt: expect.any(Number),
      });
    });

    it('passes an empty refreshKey string to onRefresh when the host does not rotate', async () => {
      const onRefresh = vi.fn();
      const { coordinator } = makeCoordinator({
        initialRefresh: 'r1',
        refreshFn: async () => ({
          access: 'acc-2',
          refresh: 'permanent-refresh',
          expires: Date.now() + 3_600_000,
        }),
        refreshKeyReturns: () => undefined, // does NOT rotate
        onRefresh,
      });
      await coordinator.runRefresh(new AbortController().signal);
      // formatPayload translates undefined refreshKey to '' so callers can
      // always stringify the payload without null-checks.
      expect(onRefresh).toHaveBeenCalledWith({
        accessToken: 'acc-2',
        refreshToken: '',
        expiresAt: expect.any(Number),
      });
    });
  });

  describe('applyTokens side effects', () => {
    it('invokes the host applyTokens callback with each refreshed pair', async () => {
      const { coordinator, applyExtraCallsRef } = makeCoordinator({
        initialRefresh: 'r1',
        applyExtra: () => {
          /* counts via closure */
        },
      });
      await coordinator.runRefresh(new AbortController().signal);
      expect(applyExtraCallsRef.value).toBe(1);
    });
  });
});
