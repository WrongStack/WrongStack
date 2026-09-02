import { describe, it, expect } from 'vitest';
import {
  addProvider,
  deleteKey,
  maskedKey,
  normalizeKeys,
  removeProvider,
  setActiveKey,
  upsertKey,
  writeKeysBack,
  type ProvidersRecord,
} from '../src/server/provider-keys.js';

describe('provider-keys', () => {
  describe('normalizeKeys', () => {
    it('returns copies of existing apiKeys array', () => {
      const cfg = {
        type: 'openai',
        apiKeys: [{ label: 'default', apiKey: 'sk-123', createdAt: '' }],
      };
      const keys = normalizeKeys(cfg);
      expect(keys).toEqual([{ label: 'default', apiKey: 'sk-123', createdAt: '' }]);
      // Should be a copy
      expect(keys[0]).not.toBe(cfg.apiKeys[0]);
    });

    it('wraps legacy apiKey string to array form', () => {
      const cfg = { type: 'openai', apiKey: 'sk-legacy' };
      const keys = normalizeKeys(cfg);
      expect(keys).toEqual([{ label: 'default', apiKey: 'sk-legacy', createdAt: '' }]);
    });

    it('returns empty array when no keys exist', () => {
      const cfg = { type: 'openai' };
      expect(normalizeKeys(cfg)).toEqual([]);
    });

    it('returns empty array when apiKeys is empty', () => {
      const cfg = { type: 'openai', apiKeys: [] };
      expect(normalizeKeys(cfg)).toEqual([]);
    });

    it('returns empty when apiKey is empty string', () => {
      const cfg = { type: 'openai', apiKey: '' };
      expect(normalizeKeys(cfg)).toEqual([]);
    });
  });

  describe('writeKeysBack', () => {
    it('clears all key fields when keys is empty', () => {
      const cfg: any = {
        type: 'openai',
        apiKeys: [{ label: 'default', apiKey: 'sk' }],
        apiKey: 'sk',
        activeKey: 'default',
      };
      writeKeysBack(cfg, []);
      expect(cfg.apiKeys).toBeUndefined();
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.activeKey).toBeUndefined();
    });

    it('writes keys and sets activeKey to first key when unset', () => {
      const cfg: any = { type: 'openai' };
      writeKeysBack(cfg, [{ label: 'mykey', apiKey: 'sk-abc', createdAt: '' }]);
      expect(cfg.apiKeys).toEqual([{ label: 'mykey', apiKey: 'sk-abc', createdAt: '' }]);
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.activeKey).toBe('mykey');
    });

    it('preserves activeKey when it still matches a key', () => {
      const cfg: any = { type: 'openai', activeKey: 'key1' };
      writeKeysBack(cfg, [
        { label: 'key1', apiKey: 'sk-1', createdAt: '' },
        { label: 'key2', apiKey: 'sk-2', createdAt: '' },
      ]);
      expect(cfg.activeKey).toBe('key1');
    });
  });

  describe('maskedKey', () => {
    it('returns em-dash for undefined key', () => {
      expect(maskedKey(undefined)).toBe('—');
    });

    it('returns em-dash for empty key', () => {
      expect(maskedKey('')).toBe('—');
    });

    it('returns full-width bullet string for keys <= 8 chars', () => {
      expect(maskedKey('short')).toBe('•••••');
      expect(maskedKey('12345678')).toBe('••••••••');
    });

    it('shows first 4 and last 4 chars for longer keys', () => {
      expect(maskedKey('abcdefghijklmnop')).toBe('abcd…mnop');
    });
  });

  describe('upsertKey', () => {
    it('adds a new key to an existing provider', () => {
      const providers: any = { openai: { type: 'openai', apiKeys: [] } };
      const result = upsertKey(providers, 'openai', 'default', 'sk-new', '2024-01-01');
      expect(result.ok).toBe(true);
      expect(providers.openai.apiKeys).toHaveLength(1);
      expect(providers.openai.apiKeys[0].apiKey).toBe('sk-new');
    });

    it('replaces an existing key with same label', () => {
      const providers: any = {
        openai: {
          type: 'openai',
          apiKeys: [{ label: 'default', apiKey: 'sk-old', createdAt: '' }],
        },
      };
      upsertKey(providers, 'openai', 'default', 'sk-new', '2024-01-01');
      expect(providers.openai.apiKeys[0].apiKey).toBe('sk-new');
      expect(providers.openai.apiKeys[0].createdAt).toBe('2024-01-01');
    });

    it('creates a new provider when it does not exist', () => {
      const providers: any = {};
      upsertKey(providers, 'anthropic', 'default', 'sk-ant', '2024-01-01');
      expect(providers.anthropic).toBeDefined();
      expect(providers.anthropic.apiKeys[0].apiKey).toBe('sk-ant');
    });

    it('sets activeKey to new label when provider has no activeKey', () => {
      const providers: any = {};
      upsertKey(providers, 'test', 'mykey', 'sk-xxx', '2024-01-01');
      expect(providers.test.activeKey).toBe('mykey');
    });
  });

  describe('deleteKey', () => {
    it('removes a key from a provider', () => {
      const providers: any = {
        openai: { type: 'openai', apiKeys: [{ label: 'default', apiKey: 'sk-1', createdAt: '' }] },
      };
      const result = deleteKey(providers, 'openai', 'default');
      expect(result.ok).toBe(true);
      expect(providers.openai).toBeUndefined();
    });

    it('returns error when provider not found', () => {
      const result = deleteKey({}, 'nonexistent', 'default');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('updates activeKey when deleting the active key', () => {
      const providers: any = {
        test: {
          type: 'test',
          activeKey: 'key1',
          apiKeys: [
            { label: 'key1', apiKey: 'sk-1', createdAt: '' },
            { label: 'key2', apiKey: 'sk-2', createdAt: '' },
          ],
        },
      };
      deleteKey(providers, 'test', 'key1');
      expect(providers.test.activeKey).toBe('key2');
    });

    it('removes provider when last key is deleted', () => {
      const providers: any = {
        test: { type: 'test', apiKeys: [{ label: 'key1', apiKey: 'sk-1', createdAt: '' }] },
      };
      deleteKey(providers, 'test', 'key1');
      expect(providers.test).toBeUndefined();
    });
  });

  describe('setActiveKey', () => {
    it('sets the active key on a provider', () => {
      const providers: any = {
        test: { type: 'test', apiKeys: [{ label: 'k1', apiKey: 'sk', createdAt: '' }] },
      };
      const result = setActiveKey(providers, 'test', 'k1');
      expect(result.ok).toBe(true);
      expect(providers.test.activeKey).toBe('k1');
    });

    it('returns error when provider not found', () => {
      const result = setActiveKey({}, 'missing', 'k1');
      expect(result.ok).toBe(false);
    });
  });

  describe('addProvider', () => {
    it('adds a new provider without a key', () => {
      const providers: any = {};
      const result = addProvider(providers, { id: 'test', family: 'openai' }, '2024-01-01');
      expect(result.ok).toBe(true);
      expect(providers.test.type).toBe('test');
      expect(providers.test.family).toBe('openai');
    });

    it('adds a new provider with an initial apiKey', () => {
      const providers: any = {};
      addProvider(providers, { id: 'test', family: 'openai', apiKey: 'sk-init' }, '2024-01-01');
      expect(providers.test.apiKeys).toHaveLength(1);
      expect(providers.test.apiKeys[0].apiKey).toBe('sk-init');
      expect(providers.test.activeKey).toBe('default');
    });

    it('returns error when provider already exists', () => {
      const providers: any = { existing: { type: 'existing' } };
      const result = addProvider(providers, { id: 'existing', family: 'openai' }, '2024-01-01');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('hydrates a Kimi Code subscription from the trusted preset (no baseUrl/family leak)', () => {
      const providers: ProvidersRecord = {};
      const result = addProvider(
        providers,
        { id: 'kimi-for-coding', family: 'openai-compatible', apiKey: 'sk-kimi-XYZ' },
        '2024-01-01',
      );
      expect(result.ok).toBe(true);
      const saved = providers['kimi-for-coding']!;
      // baseUrl/models/quirks come from the preset; the user-typed family wins.
      expect(saved.baseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(saved.envVars).toEqual(['KIMI_API_KEY']);
      expect(saved.models).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed']);
      expect((saved.quirks as { thinkingParam?: string } | undefined)?.thinkingParam).toBe(
        'kimi-toggle',
      );
      expect(saved.family).toBe('openai-compatible');
      expect(saved.type).toBe('kimi-for-coding');
      // The plaintext API key must never leak back into the legacy field.
      expect(saved.apiKey).toBeUndefined();
      expect(saved.apiKeys?.[0]?.apiKey).toBe('sk-kimi-XYZ');
    });

    it('hydrates a Moonshot Platform provider via the canonical id', () => {
      const providers: ProvidersRecord = {};
      addProvider(
        providers,
        { id: 'moonshotai', family: 'openai-compatible', apiKey: 'sk-ms-XYZ' },
        '2024-01-01',
      );
      const saved = providers.moonshotai!;
      expect(saved.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(saved.envVars).toEqual(['MOONSHOT_API_KEY']);
      expect(saved.models).toEqual(['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']);
      expect((saved.quirks as { thinkingParam?: string } | undefined)?.thinkingParam).toBe(
        'always-on',
      );
    });

    it('preserves user-supplied baseUrl/quirks when the setup flow provided them', () => {
      const providers: ProvidersRecord = {};
      addProvider(
        providers,
        {
          id: 'kimi-for-coding',
          family: 'openai-compatible',
          // A user who explicitly edits the setup card to a self-hosted
          // Kimi-compatible gateway must not have their baseUrl silently
          // overwritten by the preset hydration.
          baseUrl: 'https://internal.kimi-proxy.example/v1',
          apiKey: 'sk-int',
        },
        '2024-01-01',
      );
      const saved = providers['kimi-for-coding']!;
      expect(saved.baseUrl).toBe('https://internal.kimi-proxy.example/v1');
    });

    it('does not hydrate unknown ids (generic path is preserved)', () => {
      const providers: ProvidersRecord = {};
      addProvider(
        providers,
        { id: 'my-internal-proxy', family: 'openai-compatible', baseUrl: 'https://gw/v1' },
        '2024-01-01',
      );
      const saved = providers['my-internal-proxy']!;
      expect(saved.baseUrl).toBe('https://gw/v1');
      // No preset default models/quirks should leak in.
      expect(saved.models).toBeUndefined();
      expect(saved.envVars).toBeUndefined();
      expect(saved.quirks).toBeUndefined();
    });

    it('persists models and customModels for a generic custom provider', () => {
      const providers: ProvidersRecord = {};
      addProvider(
        providers,
        {
          id: 'my-gateway',
          family: 'openai-compatible',
          models: ['m1', 'm2'],
          customModels: {
            m1: {
              name: 'Model One',
              maxOutput: 32_768,
              capabilities: { tools: true, maxContext: 128_000 },
            },
            m2: { name: 'Model Two', capabilities: { vision: true, reasoning: true } },
          },
        },
        '2024-01-01',
      );
      const saved = providers['my-gateway']!;
      expect(saved.models).toEqual(['m1', 'm2']);
      expect(saved.customModels?.m1?.name).toBe('Model One');
      expect(saved.customModels?.m1?.maxOutput).toBe(32_768);
      expect(saved.customModels?.m1?.capabilities?.tools).toBe(true);
      expect(saved.customModels?.m1?.capabilities?.maxContext).toBe(128_000);
      expect(saved.customModels?.m2?.name).toBe('Model Two');
      expect(saved.customModels?.m2?.capabilities?.vision).toBe(true);
      expect(saved.customModels?.m2?.capabilities?.reasoning).toBe(true);
    });

    it('preset hydration overwrites any supplied models/customModels', () => {
      // Trusted presets are product-locked — a provider.add must not override
      // them with user-supplied model metadata from the custom-provider form.
      const providers: ProvidersRecord = {};
      addProvider(
        providers,
        {
          id: 'kimi-for-coding',
          family: 'openai-compatible',
          apiKey: 'sk-test',
          models: ['user-model'],
          customModels: { 'user-model': { name: 'User Model' } },
        },
        '2024-01-01',
      );
      const saved = providers['kimi-for-coding']!;
      // Preset models win, NOT the user-supplied ones. If the preset has
      // customModels they also win; if not (kimi-for-coding lacks them),
      // the field is cleared so stale user metadata isn't kept.
      expect(saved.models).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed']);
      expect(saved.customModels).toBeUndefined();
    });
  });

  describe('removeProvider', () => {
    it('removes an existing provider', () => {
      const providers: any = { test: { type: 'test' } };
      const result = removeProvider(providers, 'test');
      expect(result.ok).toBe(true);
      expect(providers.test).toBeUndefined();
    });

    it('returns error when provider not found', () => {
      const result = removeProvider({}, 'missing');
      expect(result.ok).toBe(false);
    });
  });
});
