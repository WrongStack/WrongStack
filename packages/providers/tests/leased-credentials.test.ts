/**
 * Memory-only (lease) keys from an HQ key vault: the stored entry holds a
 * marker, the value lives in the process's lease store. Resolution returns a
 * copy carrying the value — never mutating the config — and without a live
 * lease the provider is a stand-in that fails every request: never a key from
 * the environment. A lease is never renewed by the refresh coordinator (that
 * path writes to disk), auto-discovery skips it, and the store tells the host
 * when a value appears, changes or lapses — not when a renewal only extends it.
 */
import type { Config, ProviderConfig } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccountQuotaReporting } from '../src/account-quota.js';
import { resolveDiscoveryTargets } from '../src/auto-discover.js';
import {
  isExternallyRenewed,
  setExternalCredentialRefresher,
} from '../src/external-credential-refresh.js';
import {
  leasedCredentialsGeneration,
  onLeasedCredentialsChanged,
  onLeaseWanted,
  setLeasedCredentials,
} from '../src/leased-credentials.js';
import { resolveActiveKey, resolveActiveKeyEntry } from '../src/provider-build.js';
import { makeProviderFromConfig } from '../src/provider-factory.js';

const HQ = 'a'.repeat(32);
const MARKER = 'leased-by-hq:held-in-memory-only';
const ENV = 'WRONGSTACK_TEST_LEASE_ENV_KEY';

function leaseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'team',
    family: 'openai-compatible',
    baseUrl: 'https://llm.internal.example/v1',
    envVars: [ENV],
    activeKey: 'team',
    apiKeys: [
      {
        label: 'team',
        apiKey: MARKER,
        createdAt: '',
        source: { kind: 'hq', hqId: HQ, keyId: 'k1', version: 1, profileId: 'team', lease: true },
      },
    ],
    ...overrides,
  };
}

const live = (until = Date.now() + 60_000) =>
  [[`${HQ}|team|k1`, { apiKey: 'sk-leased-value', leaseUntil: until }]] as Array<
    [string, { apiKey: string; leaseUntil: number }]
  >;

afterEach(() => {
  setLeasedCredentials(HQ, []);
  delete process.env[ENV];
  setExternalCredentialRefresher(undefined);
  vi.useRealTimers();
});

describe('lease resolution', () => {
  it('resolves to a copy carrying the leased value, and to nothing without one', () => {
    const cfg = leaseConfig();
    expect(resolveActiveKeyEntry(cfg)).toBeUndefined();
    expect(resolveActiveKey(cfg)).toBeUndefined();

    setLeasedCredentials(HQ, live());
    expect(resolveActiveKey(cfg)).toBe('sk-leased-value');
    expect(resolveActiveKeyEntry(cfg)?.label).toBe('team');
    // The config object itself never holds the value.
    expect(JSON.stringify(cfg)).not.toContain('sk-leased-value');
    expect(cfg.apiKeys?.[0]?.apiKey).toBe(MARKER);
  });

  it('without a lease in time the provider fails the request — even with the env var set', async () => {
    process.env[ENV] = 'sk-from-the-environment';
    const provider = makeProviderFromConfig('team', leaseConfig());
    expect(Object.getPrototypeOf(provider)).toBe(Object.prototype); // the stand-in
    vi.useFakeTimers();
    const pending = provider
      .complete({ model: 'm', messages: [] } as never, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_001); // the wait for HQ runs out
    const error = await pending;
    vi.useRealTimers();
    expect(String((error as Error).message)).toMatch(/in memory only/);
    expect(String((error as Error).message)).not.toContain('sk-from-the-environment');

    setLeasedCredentials(HQ, live());
    expect(Object.getPrototypeOf(makeProviderFromConfig('team', leaseConfig()))).not.toBe(
      Object.prototype,
    );
  });

  it('a request sent just before the lease lands asks for it, waits, and uses it', async () => {
    const wanted: string[] = [];
    const offWant = onLeaseWanted((hqId) => wanted.push(hqId));
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 400 });
      }),
    );
    try {
      const provider = makeProviderFromConfig('team', leaseConfig());
      setTimeout(() => setLeasedCredentials(HQ, live()), 50);
      await provider
        .complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as never, {
          signal: AbortSignal.timeout(10_000),
        })
        .catch(() => undefined);
      expect(wanted).toEqual([HQ]);
      expect(seen).toContain('Bearer sk-leased-value');
    } finally {
      offWant();
      vi.unstubAllGlobals();
    }
  });

  it('a lapsed lease resolves to nothing', () => {
    setLeasedCredentials(HQ, live(Date.now() - 1));
    expect(resolveActiveKey(leaseConfig())).toBeUndefined();
  });

  it('the post-turn quota read never falls back to the environment key once the lease lapses', async () => {
    process.env[ENV] = 'sk-from-the-environment';
    setAccountQuotaReporting(true);
    const sent: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        sent.push({
          url: String(url),
          auth: new Headers(init?.headers).get('authorization') ?? '',
        });
        return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 400 });
      }),
    );
    try {
      setLeasedCredentials(HQ, live());
      const provider = makeProviderFromConfig(
        'team',
        leaseConfig({ quotaEndpoint: { url: 'https://llm.internal.example/quota', percent: 'p' } }),
      );
      setLeasedCredentials(HQ, []); // HQ withdrew the lease, or it ran out
      await provider
        .complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as never, {
          signal: AbortSignal.timeout(5_000),
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50)); // the detached quota read
      expect(sent.map((call) => call.auth)).not.toContain('Bearer sk-from-the-environment');
    } finally {
      setAccountQuotaReporting(false);
      vi.unstubAllGlobals();
    }
  });

  it('a leased OAuth account is never renewed by the refresh coordinator', () => {
    setExternalCredentialRefresher(async (_id, credential) => credential);
    const entry = { ...leaseConfig().apiKeys![0]!, authMethod: 'oauth' as const };
    expect(isExternallyRenewed(entry)).toBe(false);
    const { lease: _lease, ...stored } = entry.source!;
    expect(isExternallyRenewed({ ...entry, source: stored })).toBe(true);
  });

  it('auto-discovery skips a leased provider', () => {
    const config = {
      providers: { team: leaseConfig({ autoDiscoverModels: true }) },
    } as unknown as Config;
    setLeasedCredentials(HQ, live());
    expect(resolveDiscoveryTargets(config).map((t) => t.id)).not.toContain('team');
  });
});

describe('lease store notifications', () => {
  it('fires on a new or changed value, not on a renewal that only extends it', () => {
    const heard = vi.fn();
    const off = onLeasedCredentialsChanged(heard);
    try {
      const start = leasedCredentialsGeneration();
      setLeasedCredentials(HQ, live());
      expect(heard).toHaveBeenCalledTimes(1);
      setLeasedCredentials(HQ, live(Date.now() + 120_000));
      expect(heard).toHaveBeenCalledTimes(1);
      setLeasedCredentials(HQ, [
        [`${HQ}|team|k1`, { apiKey: 'sk-rotated', leaseUntil: Date.now() + 60_000 }],
      ]);
      expect(heard).toHaveBeenCalledTimes(2);
      expect(leasedCredentialsGeneration()).toBe(start + 2);
    } finally {
      off();
    }
  });

  it('a partial update replaces only the named profiles', () => {
    setLeasedCredentials(HQ, [
      [`${HQ}|team|k1`, { apiKey: 'sk-a', leaseUntil: Date.now() + 60_000 }],
      [`${HQ}|other|k2`, { apiKey: 'sk-b', leaseUntil: Date.now() + 60_000 }],
    ]);
    setLeasedCredentials(HQ, [], { profileIds: ['other'] });
    expect(resolveActiveKey(leaseConfig())).toBe('sk-a');
  });

  it('drops a lease when it lapses and says so', () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    const off = onLeasedCredentialsChanged(heard);
    try {
      setLeasedCredentials(HQ, live(Date.now() + 1_000));
      heard.mockClear();
      vi.advanceTimersByTime(1_001);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(resolveActiveKey(leaseConfig())).toBeUndefined();
    } finally {
      off();
    }
  });
});
