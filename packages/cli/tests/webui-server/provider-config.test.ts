import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getVault, loadSavedProviders, saveProviders, createProviderConfigStore } from '../../src/webui-server/provider-config.js';

describe('provider-config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.env.TEMP || '/tmp', `test-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  describe('getVault', () => {
    it('creates vault with correct keyFile path', () => {
      const configPath = path.join(tempDir, 'config.json');
      const vault = getVault(configPath);
      expect(vault).toBeDefined();
    });

    it('handles undefined path', () => {
      const vault = getVault(undefined);
      expect(vault).toBeDefined();
    });
  });

  describe('loadSavedProviders', () => {
    it('returns empty object when path is undefined', async () => {
      const result = await loadSavedProviders(undefined);
      expect(result).toEqual({});
    });

    it('returns empty object when file does not exist', async () => {
      const result = await loadSavedProviders(path.join(tempDir, 'nonexistent.json'));
      expect(result).toEqual({});
    });

    it('loads providers from config file', async () => {
      const configPath = path.join(tempDir, 'config.json');
      const configContent = {
        providers: {
          anthropic: { apiKey: 'test-key', models: ['anthropic-test-model'] },
        },
      };
      fsSync.writeFileSync(configPath, JSON.stringify(configContent));

      const result = await loadSavedProviders(configPath);
      expect(result).toEqual(configContent.providers);
    });
  });

  describe('saveProviders', () => {
    it('does nothing when path is undefined', async () => {
      await expect(saveProviders(undefined, { anthropic: {} as never })).resolves.not.toThrow();
    });

    it('saves providers to config file', async () => {
      const configPath = path.join(tempDir, 'config.json');
      // Create existing config with some data
      const existingConfig = { otherField: 'value' };
      fsSync.writeFileSync(configPath, JSON.stringify(existingConfig));

      const providers = {
        anthropic: { apiKey: 'new-key', models: ['anthropic-test-model'] },
      };

      await saveProviders(configPath, providers);

      const saved = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
      // API keys are encrypted, so check structure
      expect(saved.providers.anthropic).toBeDefined();
      expect(saved.providers.anthropic.models).toEqual(['anthropic-test-model']);
      expect(saved.otherField).toBe('value'); // other fields preserved
    });

    it('creates config file if it does not exist', async () => {
      const configPath = path.join(tempDir, 'new-config.json');
      const providers = { openai: { apiKey: 'key' } as never };

      await saveProviders(configPath, providers);

      const saved = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
      expect(saved.providers.openai).toBeDefined();
    });
  });

  describe('createProviderConfigStore', () => {
    it('returns a store with load and save methods', () => {
      const store = createProviderConfigStore(path.join(tempDir, 'config.json'));
      expect(typeof store.load).toBe('function');
      expect(typeof store.save).toBe('function');
    });

    it('load returns empty when no config', async () => {
      const store = createProviderConfigStore(path.join(tempDir, 'nonexistent.json'));
      const result = await store.load();
      expect(result).toEqual({});
    });

    it('load returns empty when path is undefined', async () => {
      const store = createProviderConfigStore(undefined);
      const result = await store.load();
      expect(result).toEqual({});
    });

    it('save updates the config file', async () => {
      const configPath = path.join(tempDir, 'config.json');
      fsSync.writeFileSync(configPath, JSON.stringify({ other: 'data' }));

      const store = createProviderConfigStore(configPath);
      await store.save({ anthropic: { apiKey: 'key' } as never });

      const saved = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
      expect(saved.providers.anthropic).toBeDefined();
      expect(saved.other).toBe('data');
    });

    it('save does nothing when path is undefined', async () => {
      const store = createProviderConfigStore(undefined);
      await expect(store.save({})).resolves.not.toThrow();
    });
  });
});
