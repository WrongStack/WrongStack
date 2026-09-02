import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mockLoadSaved = vi.hoisted(() => vi.fn());
const mockSaveProviders = vi.hoisted(() => vi.fn());

vi.mock('../src/server/provider-config-io.js', () => ({
  loadSavedProviders: mockLoadSaved,
  saveProviders: mockSaveProviders,
}));

import {
  createProviderConfigIO,
  vaultKeyFileForConfigPath,
} from '../src/server/provider-config-standalone.js';

describe('provider-config-standalone', () => {
  it('uses the shared root vault key for profile configs', () => {
    const profileConfig = path.join('/tmp', '.wrongstack', 'profiles', 'work', 'config.json');
    expect(vaultKeyFileForConfigPath(profileConfig)).toBe(path.join('/tmp', '.wrongstack', '.key'));
  });

  describe('createProviderConfigIO', () => {
    it('returns load/save functions that delegate to provider-config-io', () => {
      const io = createProviderConfigIO('/tmp/.wrongstack/config.json');
      expect(io).toHaveProperty('load');
      expect(io).toHaveProperty('save');
      expect(typeof io.load).toBe('function');
      expect(typeof io.save).toBe('function');
    });

    it('load delegates to loadSavedProviders', async () => {
      mockLoadSaved.mockResolvedValue({ test: { type: 'test' } });
      const io = createProviderConfigIO('/tmp/.wrongstack/config.json');
      const result = await io.load();
      expect(mockLoadSaved).toHaveBeenCalled();
      expect(result).toEqual({ test: { type: 'test' } });
    });

    it('save delegates to saveProviders', async () => {
      mockSaveProviders.mockResolvedValue(undefined);
      const io = createProviderConfigIO('/tmp/.wrongstack/config.json');
      const providers = { test: { type: 'test' } };
      await io.save(providers);
      expect(mockSaveProviders).toHaveBeenCalledWith(
        '/tmp/.wrongstack/config.json',
        expect.any(Object),
        providers,
      );
    });
  });
});
