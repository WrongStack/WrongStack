import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDecrypt = vi.hoisted(() => vi.fn());
const mockEncrypt = vi.hoisted(() => vi.fn());
const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockExpectDefined = vi.hoisted(() => vi.fn((v: any) => v));

vi.mock('@wrongstack/core/security', () => ({
  decryptConfigSecrets: mockDecrypt,
  encryptConfigSecrets: mockEncrypt,
}));

vi.mock('@wrongstack/core/utils', () => ({
  expectDefined: mockExpectDefined,
  atomicWrite: mockAtomicWrite,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { createConfigWriteLock, createProviderStore } from '../src/server/provider-store.js';

describe('provider-store', () => {
  describe('createConfigWriteLock', () => {
    it('provides a serialization lock', async () => {
      const lock = createConfigWriteLock();
      expect(lock.current).toBeInstanceOf(Promise);

      const order: number[] = [];
      const { prev, release } = lock.acquire();
      // Simulate async work
      const work = prev.then(() => {
        order.push(1);
      });
      order.push(0);
      release();
      await work;
      expect(order).toEqual([0, 1]);
    });

    // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
    // pins that the initial `current` promise is already resolved (no
    // microtask delay, no first-acquire deadlock). The server's `'provides
    // a serialization lock'` only asserts `lock.current instanceof Promise`;
    // it never actually awaits it. A regression that deferred the initial
    // resolve by one tick would still pass the server test and only fail
    // here, on the first `await lock.current` in production code.
    it('starts with a resolved promise', async () => {
      const lock = createConfigWriteLock();
      await lock.current; // must not hang
    });

    // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
    // pins the multi-acquire sequencing contract. Two `acquire()` calls
    // return distinct `prev` promises that resolve in order: the first
    // resolves before the second. The server's single-acquire test cannot
    // catch a regression that collapsed the chain into a single shared
    // promise (which would still pass the one-acquire test).
    it('sequences two acquires in order', async () => {
      const lock = createConfigWriteLock();
      const { prev: first, release: releaseFirst } = lock.acquire();
      const { prev: second, release: releaseSecond } = lock.acquire();

      const order: string[] = [];
      first.then(() => order.push('first'));
      second.then(() => order.push('second'));
      releaseFirst();
      await first;
      releaseSecond();
      await second;

      expect(order).toEqual(['first', 'second']);
    });

    // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
    // asserts that the second `acquire()` returns a promise tied to the
    // first's `prev` (not to the first's full work). Each acquire should
    // capture the lock state at acquisition time; the second caller should
    // not deadlock waiting for the first caller's work to complete.
    it('returns distinct prev promises per acquire (no chain deadlock)', async () => {
      const lock = createConfigWriteLock();
      const { prev: first, release: releaseFirst } = lock.acquire();
      const { prev: second, release: releaseSecond } = lock.acquire();
      expect(first).not.toBe(second);
      releaseFirst();
      releaseSecond();
      await second; // must not hang waiting for first to do work
    });
  });

  describe('createProviderStore', () => {
    const deps = {
      profileConfigPath: '/fake/profiles/default/config.json',
      vault: {} as any,
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe('load', () => {
      it('returns empty record when file is missing', async () => {
        mockReadFile.mockRejectedValue({ code: 'ENOENT' });
        const store = createProviderStore(deps);
        const result = await store.load();
        expect(result).toEqual({});
      });

      it('returns empty record when JSON is invalid', async () => {
        mockReadFile.mockResolvedValue('not json');
        const store = createProviderStore(deps);
        const result = await store.load();
        expect(result).toEqual({});
      });

      it('returns empty record when no providers field', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({}));
        const store = createProviderStore(deps);
        const result = await store.load();
        expect(result).toEqual({});
      });

      it('returns decrypted providers', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({ providers: { test: { type: 'test' } } }));
        mockDecrypt.mockReturnValue({ test: { type: 'test' } });
        const store = createProviderStore(deps);
        const result = await store.load();
        expect(result).toEqual({ test: { type: 'test' } });
      });
    });

    describe('save', () => {
      it('reads, encrypts, and writes providers', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({}));
        mockEncrypt.mockReturnValue({ providers: { test: { type: 'test' } } });
        mockAtomicWrite.mockResolvedValue(undefined);
        const store = createProviderStore(deps);

        await store.save({ test: { type: 'test' } });

        expect(mockEncrypt).toHaveBeenCalled();
        expect(mockAtomicWrite).toHaveBeenCalled();
      });

      it('starts from empty object when config missing', async () => {
        mockReadFile.mockRejectedValue({ code: 'ENOENT' });
        mockEncrypt.mockReturnValue({ providers: {} });
        mockAtomicWrite.mockResolvedValue(undefined);
        const store = createProviderStore(deps);

        await store.save({});

        expect(mockEncrypt).toHaveBeenCalledWith({ providers: {} }, deps.vault);
      });

      it('handles corrupt config during read', async () => {
        mockReadFile.mockResolvedValue('not json');
        mockEncrypt.mockReturnValue({ providers: {} });
        mockAtomicWrite.mockResolvedValue(undefined);
        const store = createProviderStore(deps);

        await store.save({});

        // Should start from empty parsed object and write successfully
        expect(mockEncrypt).toHaveBeenCalledWith({ providers: {} }, deps.vault);
      });

      // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
      // pins the exact JSON shape of the written payload: the serialized
      // blob must contain a `providers` field, and its `openai` entry must
      // round-trip. The server's `'reads, encrypts, and writes providers'`
      // only asserts `mockAtomicWrite` was called; it never parses the
      // string. A regression that wrote the encrypted envelope to the
      // wrong key (or skipped JSON.stringify) would still pass the server
      // test and only fail here, on the actual on-disk format.
      it('writes the encrypted payload as JSON containing the providers field', async () => {
        mockReadFile.mockResolvedValue('{}');
        mockEncrypt.mockReturnValue({ providers: { openai: { type: 'openai' } } });
        mockAtomicWrite.mockResolvedValue(undefined);
        const store = createProviderStore(deps);

        await store.save({ openai: { type: 'openai' } });

        expect(mockAtomicWrite).toHaveBeenCalledTimes(1);
        const written = mockAtomicWrite.mock.calls[0];
        expect(written).toBeDefined();
        const payload = JSON.parse(written![1] as string);
        expect(payload.providers).toBeDefined();
        expect(payload.providers.openai).toEqual({ type: 'openai' });
      });
    });

    describe('normalizeKeys', () => {
      it('returns copies of apiKeys array', () => {
        const store = createProviderStore(deps);
        const cfg: any = { type: 'test', apiKeys: [{ label: 'default', apiKey: 'sk' }] };
        const keys = store.normalizeKeys(cfg);
        expect(keys).toEqual([{ label: 'default', apiKey: 'sk' }]);
        expect(keys[0]).not.toBe(cfg.apiKeys[0]);
      });

      it('wraps legacy apiKey string', () => {
        const store = createProviderStore(deps);
        const keys = store.normalizeKeys({ type: 'test', apiKey: 'sk-legacy' } as any);
        expect(keys).toEqual([{ label: 'default', apiKey: 'sk-legacy', createdAt: '' }]);
      });

      it('returns empty array when no keys', () => {
        const store = createProviderStore(deps);
        expect(store.normalizeKeys({ type: 'test' } as any)).toEqual([]);
      });
    });

    describe('writeKeysBack', () => {
      it('clears key fields when empty', () => {
        const store = createProviderStore(deps);
        const cfg: any = { type: 'test', apiKeys: [{ label: 'k' }], apiKey: 'sk' };
        store.writeKeysBack(cfg, []);
        expect(cfg.apiKeys).toBeUndefined();
        expect(cfg.apiKey).toBeUndefined();
        expect(cfg.activeKey).toBeUndefined();
      });

      it('sets activeKey when unset', () => {
        const store = createProviderStore(deps);
        mockExpectDefined.mockReturnValue({ label: 'first', apiKey: 'sk' });
        const cfg: any = { type: 'test' };
        store.writeKeysBack(cfg, [{ label: 'first', apiKey: 'sk', createdAt: '' }]);
        expect(cfg.apiKeys).toEqual([{ label: 'first', apiKey: 'sk', createdAt: '' }]);
        expect(cfg.activeKey).toBe('first');
      });

      // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
      // pins the inverse branch of `sets activeKey when unset`: when an
      // activeKey is already present AND that label still exists in the new
      // key list, writeKeysBack must leave the existing pointer alone.
      // Without this, a refactor that unconditionally reassigned `activeKey`
      // to `keys[0]` would silently demote a user's chosen key to the
      // first-row default on every `key.upsert`.
      it('preserves existing activeKey when its label still exists in new keys', () => {
        // Restore identity behavior — the prior test (`sets activeKey when
        // unset`) overrode `mockExpectDefined.mockReturnValue(...)` and the
        // suite's `vi.clearAllMocks()` only clears call history, not
        // implementations, so a leak would otherwise return the stale
        // { label: 'first', ... } object here.
        mockExpectDefined.mockReset();
        mockExpectDefined.mockImplementation((v: any) => v);
        const store = createProviderStore(deps);
        const cfg: any = {
          type: 'anthropic',
          activeKey: 'personal',
          apiKeys: [
            { label: 'work', apiKey: 'sk-work', createdAt: '2025-01-01' },
            { label: 'personal', apiKey: 'sk-personal', createdAt: '2025-01-02' },
          ],
        };
        store.writeKeysBack(cfg, cfg.apiKeys);
        expect(cfg.activeKey).toBe('personal');
        expect(cfg.apiKey).toBeUndefined();
      });

      // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
      // pins the third branch of `writeKeysBack`: when activeKey points at
      // a label that no longer exists in the new key list, the pointer
      // must reset to the first remaining key. The server's two existing
      // tests cover the unset and clear cases; this covers the stale-label
      // case (e.g. user deleted the active key then re-added others).
      it('resets activeKey to the first key when the prior label is gone', () => {
        mockExpectDefined.mockReset();
        mockExpectDefined.mockImplementation((v: any) => v);
        const store = createProviderStore(deps);
        const cfg: any = {
          type: 'anthropic',
          activeKey: 'nonexistent',
          apiKey: 'sk-old',
          apiKeys: [{ label: 'work', apiKey: 'sk-work', createdAt: '2025-01-01' }],
        };
        store.writeKeysBack(cfg, cfg.apiKeys);
        expect(cfg.activeKey).toBe('work');
        expect(cfg.apiKey).toBeUndefined();
      });
    });

    describe('maskedKey', () => {
      it('returns em-dash for undefined', () => {
        const store = createProviderStore(deps);
        expect(store.maskedKey(undefined)).toBe('—');
      });

      // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
      // pins the empty-string branch. The server's `'returns em-dash for
      // undefined'` only covers `undefined`; `''` falls into the same
      // truthiness guard (`if (!key)`) but a refactor that switched to
      // `if (key === undefined)` would silently render `''` as `` (a
      // blank UI cell) instead of `—`.
      it('returns em-dash for empty string', () => {
        const store = createProviderStore(deps);
        expect(store.maskedKey('')).toBe('—');
      });

      it('returns bullets for short keys', () => {
        const store = createProviderStore(deps);
        expect(store.maskedKey('abc')).toBe('•••');
      });

      // B-07: migrated from packages/webui/tests/server/provider-store.test.ts —
      // pins the 6-character boundary. The server's `'returns bullets for
      // short keys'` only asserts 3-char; the bullet count for any key
      // `length <= 8` is `length` bullets (e.g. `'sk-abc'` → 6 bullets,
      // not 8). A regression that hard-coded `••••••••` would still pass
      // the server test but break the masking invariant here.
      it('masks a 6-character key with 6 bullets', () => {
        const store = createProviderStore(deps);
        expect(store.maskedKey('sk-abc')).toBe('••••••');
      });

      it('shows first/last 4 for long keys', () => {
        const store = createProviderStore(deps);
        expect(store.maskedKey('abcdefghijklmnop')).toBe('abcd…mnop');
      });
    });
  });
});
