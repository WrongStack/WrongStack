import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDecrypt = vi.hoisted(() => vi.fn());
const mockEncrypt = vi.hoisted(() => vi.fn());
const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/core/security', () => ({
  decryptConfigSecrets: mockDecrypt,
  encryptConfigSecrets: mockEncrypt,
}));

vi.mock('@wrongstack/core/types', () => ({
  ConfigError: class extends Error {
    constructor(opts: any) {
      super(opts.message);
      this.name = 'ConfigError';
    }
  },
}));

vi.mock('@wrongstack/core/utils', () => ({ atomicWrite: mockAtomicWrite }));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { loadSavedProviders, saveProviders } from '../src/server/provider-config-io.js';

describe('provider-config-io', () => {
  const vault = { decrypt: vi.fn(), encrypt: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSavedProviders', () => {
    it('returns empty record when file is missing', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const result = await loadSavedProviders('/fake/config.json', vault);
      expect(result).toEqual({});
    });

    it('returns empty record when JSON is invalid', async () => {
      mockReadFile.mockResolvedValue('not json');
      const result = await loadSavedProviders('/fake/config.json', vault);
      expect(result).toEqual({});
    });

    it('returns empty record when no providers field', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));
      const result = await loadSavedProviders('/fake/config.json', vault);
      expect(result).toEqual({});
    });

    it('returns decrypted providers', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ providers: { openai: { type: 'openai' } } }));
      mockDecrypt.mockReturnValue({ openai: { type: 'openai' } });
      const result = await loadSavedProviders('/fake/config.json', vault);
      expect(result).toEqual({ openai: { type: 'openai' } });
      expect(mockDecrypt).toHaveBeenCalledWith({ openai: { type: 'openai' } }, vault);
    });
  });

  describe('saveProviders', () => {
    it('reads, encrypts, and writes providers to config', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ someKey: 'value' }));
      mockEncrypt.mockReturnValue({ someKey: 'value', providers: { test: { type: 'test' } } });
      mockAtomicWrite.mockResolvedValue(undefined);

      await saveProviders('/fake/config.json', vault, { test: { type: 'test' } });

      expect(mockEncrypt).toHaveBeenCalled();
      expect(mockAtomicWrite).toHaveBeenCalledWith('/fake/config.json', expect.any(String), {
        mode: 0o600,
      });
    });

    it('starts from empty object when file has ENOENT', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockEncrypt.mockReturnValue({ providers: { test: { type: 'test' } } });
      mockAtomicWrite.mockResolvedValue(undefined);

      await saveProviders('/fake/config.json', vault, { test: { type: 'test' } });

      expect(mockEncrypt).toHaveBeenCalledWith({ providers: { test: { type: 'test' } } }, vault);
    });

    it('throws ConfigError when read fails with non-ENOENT error', async () => {
      mockReadFile.mockRejectedValue({ code: 'EACCES', message: 'Permission denied' });
      await expect(saveProviders('/fake/config.json', vault, {})).rejects.toThrow(
        'Refusing to mutate',
      );
    });

    it('throws ConfigError when existing config is corrupt', async () => {
      mockReadFile.mockResolvedValue('not valid json');
      await expect(saveProviders('/fake/config.json', vault, {})).rejects.toThrow(
        'Refusing to overwrite corrupt config',
      );
    });

    it('handles empty string as corrupt config when file exists', async () => {
      mockReadFile.mockResolvedValue('');
      await expect(saveProviders('/fake/config.json', vault, {})).rejects.toThrow(
        'Refusing to overwrite corrupt config',
      );
    });
  });
});
