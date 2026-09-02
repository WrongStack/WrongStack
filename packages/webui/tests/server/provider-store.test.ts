import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createProviderStore,
  createConfigWriteLock,
  type ProviderStore,
} from '@wrongstack/webui-server';
import type { ProviderConfig } from '@wrongstack/core/types';

// Hoisted so vi.mock can reference them at the top level
const { mockReadFile, mockAtomicWrite } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockAtomicWrite: vi.fn(),
}));

vi.mock('node:fs/promises', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = require('node:fs/promises');
  return {
    ...actual,
    default: actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    atomicWrite: (...args: unknown[]) => mockAtomicWrite(...args),
  };
});

// ---- createConfigWriteLock ----
describe('createConfigWriteLock', () => {
  it('starts with resolved promise', async () => {
    const lock = createConfigWriteLock();
    await lock.current; // should not throw
  });

  it('sequences two acquires', async () => {
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

  it('second acquire does not block waiting for first to finish', async () => {
    const lock = createConfigWriteLock();
    const { prev: first, release: releaseFirst } = lock.acquire();
    const { prev: second, release: releaseSecond } = lock.acquire();
    // Second acquire returns a promise that resolves immediately after the
    // first's prev resolves, not after the first's work is done.
    expect(first).not.toBe(second);
    releaseFirst();
    releaseSecond();
    await second; // should not hang
  });
});

// ---- ProviderStore ----
describe('ProviderStore', () => {
  const mockVault = {
    encrypt: vi.fn().mockImplementation((data) => ({ encrypted: data })),
    decrypt: vi
      .fn()
      .mockImplementation((data) => (data as { encrypted?: unknown }).encrypted ?? {}),
    isEncrypted: vi.fn().mockReturnValue(false),
    encryptSync: vi.fn(),
    decryptSync: vi.fn(),
  } as never as import('@wrongstack/core/security').DefaultSecretVault;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue('{}');
    mockAtomicWrite.mockReset();
    mockAtomicWrite.mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

  const makeStore = (): ProviderStore =>
    createProviderStore({
      profileConfigPath: '/test/profiles/default/config.json',
      vault: mockVault,
    });

  describe('normalizeKeys', () => {
    it('returns apiKeys array as-is (shallow copy)', () => {
      const store = makeStore();
      const cfg: ProviderConfig = {
        type: 'anthropic',
        apiKeys: [{ label: 'k1', apiKey: 'sk-1', createdAt: '2025-01-01' }],
      };
      const result = store.normalizeKeys(cfg);
      expect(result).toEqual([{ label: 'k1', apiKey: 'sk-1', createdAt: '2025-01-01' }]);
      expect(result).not.toBe(cfg.apiKeys);
    });

    it('migrates legacy single apiKey field', () => {
      const store = makeStore();
      const cfg: ProviderConfig = { type: 'openai', apiKey: 'sk-secret' };
      expect(store.normalizeKeys(cfg)).toEqual([
        { label: 'default', apiKey: 'sk-secret', createdAt: '' },
      ]);
    });

    it('returns empty array when no keys', () => {
      const store = makeStore();
      expect(store.normalizeKeys({ type: 'openai' })).toEqual([]);
    });
  });

  describe('writeKeysBack', () => {
    it('clears all key fields when empty array', () => {
      const store = makeStore();
      const cfg: ProviderConfig = {
        type: 'anthropic',
        apiKeys: [{ label: 'k1', apiKey: 'sk-1', createdAt: '2025-01-01' }],
        activeKey: 'k1',
        apiKey: 'sk-1',
      };
      store.writeKeysBack(cfg, []);
      expect(cfg.apiKeys).toBeUndefined();
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.activeKey).toBeUndefined();
    });

    it('writes keys back and points activeKey at the first key when none prior', () => {
      const store = makeStore();
      const cfg: ProviderConfig = { type: 'anthropic' };
      store.writeKeysBack(cfg, [
        { label: 'work', apiKey: 'sk-work', createdAt: '2025-01-01' },
        { label: 'personal', apiKey: 'sk-personal', createdAt: '2025-01-02' },
      ]);
      expect(cfg.apiKeys).toHaveLength(2);
      expect(cfg.activeKey).toBe('work');
      // No plaintext mirror to the legacy `apiKey`; the secret lives in apiKeys[].
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.apiKeys?.find((k) => k.label === cfg.activeKey)?.apiKey).toBe('sk-work');
    });

    it('preserves existing activeKey if it still exists in new keys', () => {
      const store = makeStore();
      const cfg: ProviderConfig = {
        type: 'anthropic',
        activeKey: 'personal',
        apiKeys: [
          { label: 'work', apiKey: 'sk-work', createdAt: '2025-01-01' },
          { label: 'personal', apiKey: 'sk-personal', createdAt: '2025-01-02' },
        ],
      };
      store.writeKeysBack(cfg, cfg.apiKeys!);
      expect(cfg.activeKey).toBe('personal');
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.apiKeys?.find((k) => k.label === cfg.activeKey)?.apiKey).toBe('sk-personal');
    });

    it('resets activeKey to first key if prior activeKey is gone', () => {
      const store = makeStore();
      const cfg: ProviderConfig = {
        type: 'anthropic',
        activeKey: 'nonexistent',
        apiKey: 'sk-old',
        apiKeys: [{ label: 'work', apiKey: 'sk-work', createdAt: '2025-01-01' }],
      };
      store.writeKeysBack(cfg, cfg.apiKeys!);
      expect(cfg.activeKey).toBe('work');
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.apiKeys?.find((k) => k.label === cfg.activeKey)?.apiKey).toBe('sk-work');
    });
  });

  describe('maskedKey', () => {
    it('returns dash for undefined/empty', () => {
      const store = makeStore();
      expect(store.maskedKey(undefined)).toBe('—');
      expect(store.maskedKey('')).toBe('—');
    });

    it('masks short keys entirely', () => {
      const store = makeStore();
      expect(store.maskedKey('abc')).toBe('•••');
      expect(store.maskedKey('sk-abc')).toBe('••••••');
    });

    it('shows prefix and suffix for longer keys', () => {
      const store = makeStore();
      // First 4 chars + … + last 4 chars
      expect(store.maskedKey('sk-ant1234567')).toBe('sk-a…4567');
    });
  });

  describe('load', () => {
    it('returns empty object when file not found', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const store = makeStore();
      await expect(store.load()).resolves.toEqual({});
    });

    it('decrypts and returns providers from file', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          providers: { anthropic: { type: 'anthropic', apiKey: 'sk-test' } },
        }),
      );
      const store = makeStore();
      const result = await store.load();
      expect(mockVault.decrypt).toHaveBeenCalled();
      expect(result).toHaveProperty('anthropic');
    });

    it('returns empty object when no providers key', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));
      const store = makeStore();
      await expect(store.load()).resolves.toEqual({});
    });
  });

  describe('save', () => {
    it('calls atomicWrite with encrypted providers', async () => {
      const store = makeStore();
      await store.save({ openai: { type: 'openai', apiKey: 'sk-new' } });
      expect(mockAtomicWrite).toHaveBeenCalled();
      const written = mockAtomicWrite.mock.calls[0]!;
      const payload = JSON.parse(written[1] as string);
      expect(payload.providers).toBeDefined();
    });

    it('serializes current config even when file is unreadable', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const store = makeStore();
      await store.save({ openai: { type: 'openai' } });
      expect(mockAtomicWrite).toHaveBeenCalled();
    });
  });
});
