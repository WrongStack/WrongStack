/**
 * Integration tests for desktop-config-io module.
 * Uses mock filesystem to test config read/write cycle.
 * Tests the full encrypt → write → read → decrypt round-trip.
 */
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockFileStore = new Map<string, string>();

// Mock the core security module
vi.mock('@wrongstack/core/security', () => ({
  DefaultSecretVault: class MockSecretVault {
    encrypt = vi.fn((value: string) => value);
    decrypt = vi.fn((value: string) => value);
    hasKey = vi.fn(() => true);
  },
  decryptConfigSecrets: vi.fn((data: Record<string, unknown>) => {
    // Identity transformation for testing - preserves the data shape
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!k.startsWith('__encrypted__')) {
        result[k] = v;
      }
    }
    return result;
  }),
  encryptConfigSecrets: vi.fn((data: Record<string, unknown>) => {
    // Identity transformation - mirrors back the data
    return { ...data };
  }),
}));

vi.mock('@wrongstack/core/utils', () => ({
  atomicWrite: vi.fn(async (filePath: string, content: string) => {
    mockFileStore.set(filePath, content);
  }),
  wstackGlobalRoot: vi.fn(() => '/mock/wstack/root'),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (filePath: string) => {
    const content = mockFileStore.get(filePath);
    if (content === undefined) throw new Error('ENOENT: file not found');
    return content;
  }),
  mkdir: vi.fn(async () => undefined),
}));

import {
  desktopConfigPaths,
  readUiLocale,
  resolveActiveProfileConfigPath,
  writeUiLocale,
} from '../src/main/desktop-config-io.js';

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  mockFileStore.clear();
});

// ============================================================================
// readUiLocale Tests
// ============================================================================

describe('readUiLocale', () => {
  it('should return undefined when config file does not exist', async () => {
    const result = await readUiLocale();
    expect(result).toBeUndefined();
  });

  it('should return undefined when config file is empty', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, '{}');
    const result = await readUiLocale();
    expect(result).toBeUndefined();
  });

  it('should read locale from config', async () => {
    const config = JSON.stringify({ uiLocale: 'tr' });
    mockFileStore.set(desktopConfigPaths.profileConfigPath, config);
    const result = await readUiLocale();
    expect(result).toBe('tr');
  });

  it('should resolve and read the profile selected by the root bootstrap', async () => {
    mockFileStore.set(
      desktopConfigPaths.bootstrapConfigPath,
      JSON.stringify({ version: 1, activeProfile: 'work' }),
    );
    const workProfile = path.join('/mock/wstack/root', 'profiles', 'work', 'config.json');
    mockFileStore.set(workProfile, JSON.stringify({ uiLocale: 'tr' }));

    expect(await resolveActiveProfileConfigPath()).toBe(workProfile);
    expect(await readUiLocale()).toBe('tr');
  });

  it('should read different locale values', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({ uiLocale: 'de' }));
    expect(await readUiLocale()).toBe('de');
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({ uiLocale: 'fr' }));
    expect(await readUiLocale()).toBe('fr');
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({ uiLocale: 'pt-BR' }));
    expect(await readUiLocale()).toBe('pt-BR');
  });

  it('should return undefined when locale is empty string', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({ uiLocale: '' }));
    const result = await readUiLocale();
    expect(result).toBeUndefined();
  });

  it('should return undefined when locale is not a string', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({ uiLocale: 42 }));
    const result = await readUiLocale();
    expect(result).toBeUndefined();
  });

  it('should return undefined when config has invalid JSON', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, '{invalid json}');
    const result = await readUiLocale();
    expect(result).toBeUndefined();
  });

  it('should handle encrypted config gracefully', async () => {
    const encryptedConfig = JSON.stringify({
      __encrypted__secret: 'some-encrypted-value',
      uiLocale: 'fr',
    });
    mockFileStore.set(desktopConfigPaths.profileConfigPath, encryptedConfig);
    const result = await readUiLocale();
    expect(result).toBe('fr');
  });
});

// ============================================================================
// writeUiLocale Tests
// ============================================================================

describe('writeUiLocale', () => {
  it('should write locale to new config file', async () => {
    await writeUiLocale('tr');
    const stored = mockFileStore.get(desktopConfigPaths.profileConfigPath);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.uiLocale).toBe('tr');
  });

  it('should update locale in existing config', async () => {
    mockFileStore.set(
      desktopConfigPaths.profileConfigPath,
      JSON.stringify({ uiLocale: 'en', someKey: 'value' }),
    );
    await writeUiLocale('de');
    const stored = mockFileStore.get(desktopConfigPaths.profileConfigPath);
    const parsed = JSON.parse(stored!);
    expect(parsed.uiLocale).toBe('de');
    expect(parsed.someKey).toBe('value');
  });

  it('should write to the profile selected by the root bootstrap', async () => {
    mockFileStore.set(
      desktopConfigPaths.bootstrapConfigPath,
      JSON.stringify({ version: 1, activeProfile: 'work' }),
    );
    const workProfile = path.join('/mock/wstack/root', 'profiles', 'work', 'config.json');
    mockFileStore.set(workProfile, JSON.stringify({ uiLocale: 'en', provider: 'openai' }));

    await writeUiLocale('de');

    expect(JSON.parse(mockFileStore.get(workProfile)!)).toEqual({
      uiLocale: 'de',
      provider: 'openai',
    });
    expect(mockFileStore.get(desktopConfigPaths.bootstrapConfigPath)).toBe(
      JSON.stringify({ version: 1, activeProfile: 'work' }),
    );
  });

  it('should handle missing original config gracefully', async () => {
    // No mockFileStore entry - simulates first-time write
    await writeUiLocale('fr');
    const stored = mockFileStore.get(desktopConfigPaths.profileConfigPath);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.uiLocale).toBe('fr');
  });

  it('should not clobber corrupt config', async () => {
    mockFileStore.set(desktopConfigPaths.profileConfigPath, '{corrupt}');
    await writeUiLocale('fr');
    const stored = mockFileStore.get(desktopConfigPaths.profileConfigPath);
    // Should still be the corrupt content
    expect(stored).toBe('{corrupt}');
  });

  it('should preserve existing fields when updating locale', async () => {
    mockFileStore.set(
      desktopConfigPaths.profileConfigPath,
      JSON.stringify({
        uiLocale: 'en',
        theme: 'dark',
        fontSize: 14,
        windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
      }),
    );
    await writeUiLocale('tr');
    const stored = mockFileStore.get(desktopConfigPaths.profileConfigPath);
    const parsed = JSON.parse(stored!);
    expect(parsed.uiLocale).toBe('tr');
    expect(parsed.theme).toBe('dark');
    expect(parsed.fontSize).toBe(14);
    expect(parsed.windowBounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });
});

// ============================================================================
// Round-trip Tests
// ============================================================================

describe('Config round-trip', () => {
  it('should write then read locale correctly', async () => {
    await writeUiLocale('es');
    const result = await readUiLocale();
    expect(result).toBe('es');
  });

  it('should handle multiple write-read cycles', async () => {
    const locales = ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR'];
    for (const locale of locales) {
      await writeUiLocale(locale);
      const result = await readUiLocale();
      expect(result).toBe(locale);
    }
  });

  it('should read en after write then read cycle', async () => {
    await writeUiLocale('en');
    expect(await readUiLocale()).toBe('en');
  });

  it('should return undefined after resetting locale to empty', async () => {
    await writeUiLocale('tr');
    expect(await readUiLocale()).toBe('tr');
    // Write empty object (simulating clearing locale)
    mockFileStore.set(desktopConfigPaths.profileConfigPath, JSON.stringify({}));
    expect(await readUiLocale()).toBeUndefined();
  });
});

// ============================================================================
// DesktopConfigPaths Tests
// ============================================================================

describe('desktopConfigPaths', () => {
  it('should define profileConfigPath', () => {
    expect(desktopConfigPaths.profileConfigPath).toBeDefined();
    expect(typeof desktopConfigPaths.profileConfigPath).toBe('string');
  });

  it('should define vault', () => {
    expect(desktopConfigPaths.vault).toBeDefined();
  });
});
