import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  loadSavedProviders,
  saveProviders,
} from '@wrongstack/webui-server/server/provider-config-io.js';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockDecryptSecrets = vi.hoisted(() => vi.fn());
const mockEncryptSecrets = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('@wrongstack/core/utils', () => ({
  atomicWrite: mockAtomicWrite,
}));

vi.mock('@wrongstack/core/types', () => ({
  // provider-config-io throws ConfigError on the corrupt / non-ENOENT paths;
  // the mock factory must surface it or access throws "no export defined".
  ConfigError: class ConfigError extends Error {
    code?: string;
    constructor(opts: { message: string; code?: string } | string) {
      const message = typeof opts === 'string' ? opts : opts.message;
      super(message);
      this.name = 'ConfigError';
      if (typeof opts !== 'string') this.code = opts.code;
    }
  },
}));

vi.mock('@wrongstack/core/security', () => ({
  decryptConfigSecrets: mockDecryptSecrets,
  encryptConfigSecrets: mockEncryptSecrets,
}));

// Minimal vault mock
const mockVault = {
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace('encrypted:', '')),
};

describe('loadSavedProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty record when file does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await loadSavedProviders('/path/config.json', mockVault as any);
    expect(result).toEqual({});
  });

  it('returns empty record on corrupt JSON', async () => {
    mockReadFile.mockResolvedValueOnce('not valid json {{{');
    const result = await loadSavedProviders('/path/config.json', mockVault as any);
    expect(result).toEqual({});
  });

  it('returns empty record when providers key is missing', async () => {
    mockReadFile.mockResolvedValueOnce('{"other": "data"}');
    const result = await loadSavedProviders('/path/config.json', mockVault as any);
    expect(result).toEqual({});
  });

  it('decrypts and returns providers when present', async () => {
    const providers = {
      anthropic: { provider: 'anthropic', apiKey: 'encrypted:sk-xxx' },
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ providers }));
    mockDecryptSecrets.mockReturnValueOnce(providers);
    const result = await loadSavedProviders('/path/config.json', mockVault as any);
    expect(result).toEqual(providers);
    expect(mockDecryptSecrets).toHaveBeenCalledWith(providers, mockVault);
  });
});

describe('saveProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes encrypted providers to config', async () => {
    mockReadFile.mockResolvedValueOnce('{}');
    mockEncryptSecrets.mockReturnValueOnce({ providers: { anthropic: {} } });
    const providers = { anthropic: { provider: 'anthropic' } as any };

    await saveProviders('/path/config.json', mockVault as any, providers);

    expect(mockEncryptSecrets).toHaveBeenCalled();
    expect(mockAtomicWrite).toHaveBeenCalledWith('/path/config.json', expect.any(String), {
      mode: 0o600,
    });
  });

  it('merges with existing config', async () => {
    mockReadFile.mockResolvedValueOnce('{"theme": "dark"}');
    mockEncryptSecrets.mockReturnValueOnce({ theme: 'dark', providers: { anthropic: {} } });
    const providers = { anthropic: { provider: 'anthropic' } as any };

    await saveProviders('/path/config.json', mockVault as any, providers);

    expect(mockAtomicWrite).toHaveBeenCalledWith(
      '/path/config.json',
      expect.stringContaining('theme'),
      { mode: 0o600 },
    );
  });

  it('throws on corrupt existing file (refuses to overwrite)', async () => {
    mockReadFile.mockResolvedValueOnce('not json {{{');
    const providers = { anthropic: { provider: 'anthropic' } as any };

    await expect(saveProviders('/path/config.json', mockVault as any, providers)).rejects.toThrow(
      'Refusing to overwrite corrupt config',
    );
  });

  it('throws on non-ENOENT read errors', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const providers = { anthropic: { provider: 'anthropic' } as any };

    await expect(saveProviders('/path/config.json', mockVault as any, providers)).rejects.toThrow(
      'Refusing to mutate',
    );
  });

  it('starts fresh on missing config file', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockEncryptSecrets.mockReturnValueOnce({ providers: { anthropic: {} } });
    const providers = { anthropic: { provider: 'anthropic' } as any };

    await saveProviders('/path/config.json', mockVault as any, providers);

    expect(mockAtomicWrite).toHaveBeenCalled();
  });
});
