import type { ProviderConfig } from '@wrongstack/core/types';
import { SETUP_MODEL_ID, SETUP_PROVIDER_ID } from '@wrongstack/providers';
import { describe, expect, it } from 'vitest';
import {
  activeLabel,
  clearStaleProviderDefaults,
  maskedKey,
  normalizeKeys,
  nowIso,
  resolveActiveApiKey,
  writeKeysBack,
} from '../src/provider-config-utils.js';

// Strip ANSI color codes so masking assertions don't depend on terminal
// support — the production `maskedKey` wraps slices in `color.dim` which
// embeds escape sequences when the env supports color.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('normalizeKeys', () => {
  it('returns a deep-copied list when apiKeys is already populated', () => {
    const cfg: ProviderConfig = {
      apiKeys: [
        { label: 'work', apiKey: 'sk-work', createdAt: '2026-01-01' },
        { label: 'home', apiKey: 'sk-home', createdAt: '2026-02-02' },
      ],
    } as ProviderConfig;
    const out = normalizeKeys(cfg);
    expect(out).toHaveLength(2);
    expect(out[0]?.apiKey).toBe('sk-work');
    // Mutation isolation: editing the result must not poison the input.
    out[0]!.apiKey = 'mutated';
    expect(cfg.apiKeys?.[0]?.apiKey).toBe('sk-work');
  });

  it('migrates legacy single apiKey to the new shape', () => {
    const cfg: ProviderConfig = { apiKey: 'sk-legacy' } as ProviderConfig;
    const out = normalizeKeys(cfg);
    expect(out).toEqual([{ label: 'default', apiKey: 'sk-legacy', createdAt: '' }]);
  });

  it('prefers apiKeys over apiKey when both are present', () => {
    const cfg: ProviderConfig = {
      apiKeys: [{ label: 'new', apiKey: 'sk-new', createdAt: '' }],
      apiKey: 'sk-stale',
    } as ProviderConfig;
    const out = normalizeKeys(cfg);
    expect(out).toEqual([{ label: 'new', apiKey: 'sk-new', createdAt: '' }]);
  });

  it('returns empty list when neither shape is present', () => {
    expect(normalizeKeys({} as ProviderConfig)).toEqual([]);
  });

  it('returns empty list for empty apiKeys array', () => {
    const cfg = { apiKeys: [] } as never as ProviderConfig;
    expect(normalizeKeys(cfg)).toEqual([]);
  });

  it('treats empty-string apiKey as no key', () => {
    const cfg = { apiKey: '' } as ProviderConfig;
    expect(normalizeKeys(cfg)).toEqual([]);
  });
});

describe('writeKeysBack', () => {
  it('clears all three fields when given an empty list', () => {
    const cfg = {
      apiKeys: [{ label: 'x', apiKey: 'sk-x', createdAt: '' }],
      apiKey: 'sk-x',
      activeKey: 'x',
    } as ProviderConfig;
    writeKeysBack(cfg, []);
    expect(cfg.apiKeys).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.activeKey).toBeUndefined();
  });

  it('clears the legacy apiKey field to prevent serialization leaks', () => {
    const cfg = { activeKey: 'b' } as ProviderConfig;
    const keys = [
      { label: 'a', apiKey: 'sk-a', createdAt: '' },
      { label: 'b', apiKey: 'sk-b', createdAt: '' },
    ];
    writeKeysBack(cfg, keys);
    // apiKey is cleared — consumers must use resolveActiveApiKey() instead
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.activeKey).toBe('b');
    expect(cfg.apiKeys).toHaveLength(2);
    // resolveActiveApiKey returns the real key from apiKeys[]
    expect(resolveActiveApiKey(cfg)).toBe('sk-b');
  });

  it('falls back to first key when activeKey points at a missing label', () => {
    const cfg = { activeKey: 'ghost' } as ProviderConfig;
    const keys = [{ label: 'real', apiKey: 'sk-real', createdAt: '' }];
    writeKeysBack(cfg, keys);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.activeKey).toBe('real');
    expect(resolveActiveApiKey(cfg)).toBe('sk-real');
  });

  it('falls back to first key when activeKey is unset', () => {
    const cfg = {} as ProviderConfig;
    const keys = [
      { label: 'first', apiKey: 'sk-first', createdAt: '' },
      { label: 'second', apiKey: 'sk-second', createdAt: '' },
    ];
    writeKeysBack(cfg, keys);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.activeKey).toBe('first');
    expect(resolveActiveApiKey(cfg)).toBe('sk-first');
  });

  it('preserves activeKey when it matches an entry', () => {
    const cfg = { activeKey: 'work' } as ProviderConfig;
    const keys = [
      { label: 'home', apiKey: 'sk-home', createdAt: '' },
      { label: 'work', apiKey: 'sk-work', createdAt: '' },
    ];
    writeKeysBack(cfg, keys);
    expect(cfg.activeKey).toBe('work');
    expect(cfg.apiKey).toBeUndefined();
    expect(resolveActiveApiKey(cfg)).toBe('sk-work');
  });
});

describe('resolveActiveApiKey', () => {
  it('returns the active key from apiKeys[] when activeKey is set', () => {
    const cfg: ProviderConfig = {
      apiKeys: [
        { label: 'a', apiKey: 'sk-a', createdAt: '' },
        { label: 'b', apiKey: 'sk-b', createdAt: '' },
      ],
      activeKey: 'b',
    } as ProviderConfig;
    expect(resolveActiveApiKey(cfg)).toBe('sk-b');
  });

  it('returns the first key when activeKey is unset', () => {
    const cfg: ProviderConfig = {
      apiKeys: [
        { label: 'first', apiKey: 'sk-first', createdAt: '' },
        { label: 'second', apiKey: 'sk-second', createdAt: '' },
      ],
    } as ProviderConfig;
    expect(resolveActiveApiKey(cfg)).toBe('sk-first');
  });

  it('falls back to legacy apiKey when apiKeys is empty', () => {
    const cfg: ProviderConfig = { apiKey: 'sk-legacy' } as ProviderConfig;
    expect(resolveActiveApiKey(cfg)).toBe('sk-legacy');
  });

  it('returns undefined when no key is configured', () => {
    expect(resolveActiveApiKey({} as ProviderConfig)).toBeUndefined();
  });

  it('returns undefined for empty-string legacy apiKey', () => {
    const cfg = { apiKey: '' } as ProviderConfig;
    expect(resolveActiveApiKey(cfg)).toBeUndefined();
  });
});

describe('clearStaleProviderDefaults', () => {
  it('clears top-level provider/model when the provider was removed', () => {
    const config: Record<string, unknown> = {
      provider: 'openai',
      model: 'gpt-4o',
      providers: {},
    };
    clearStaleProviderDefaults(config);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it('clears top-level provider/model when the active provider has no usable key', () => {
    const config: Record<string, unknown> = {
      provider: 'openai',
      model: 'gpt-4o',
      providers: { openai: { type: 'openai', apiKeys: [] } },
    };
    clearStaleProviderDefaults(config);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it('clears only the default model when it is no longer in the provider model list', () => {
    const config: Record<string, unknown> = {
      provider: 'openai',
      model: 'old-model',
      providers: {
        openai: {
          type: 'openai',
          apiKeys: [{ label: 'default', apiKey: 'sk-test', createdAt: '' }],
          models: ['new-model'],
        },
      },
    };
    clearStaleProviderDefaults(config);
    expect(config.provider).toBe('openai');
    expect(config.model).toBeUndefined();
  });

  it('keeps keyless loopback providers as usable defaults', () => {
    const config: Record<string, unknown> = {
      provider: 'ollama',
      model: 'llama3',
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          envVars: [],
          models: ['llama3'],
        },
      },
    };
    clearStaleProviderDefaults(config);
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('llama3');
  });

  // Setup mode is the no-credential placeholder the first-run gate installs.
  // This function runs on every credential write, so reaching it means a real
  // provider was just configured — the placeholder must not survive it.
  it('retires setup mode when a credential write happens', () => {
    const config: Record<string, unknown> = {
      provider: SETUP_PROVIDER_ID,
      model: SETUP_MODEL_ID,
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKeys: [{ label: 'default', apiKey: 'sk-ant-test', createdAt: '' }],
        },
      },
    };
    clearStaleProviderDefaults(config);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    // The real provider the user just added is untouched.
    expect(Object.keys(config.providers as Record<string, unknown>)).toEqual(['anthropic']);
  });

  it('deletes a hand-written setup-mode providers entry', () => {
    // The code never creates this entry; a hand-edited config might. Left in
    // place it would make setup mode look like a configured provider forever.
    const config: Record<string, unknown> = {
      provider: SETUP_PROVIDER_ID,
      model: SETUP_MODEL_ID,
      providers: { [SETUP_PROVIDER_ID]: { type: SETUP_PROVIDER_ID } },
    };
    clearStaleProviderDefaults(config);
    expect(config.providers).toEqual({});
  });
});

describe('activeLabel', () => {
  it('returns activeKey when it matches an entry', () => {
    const cfg = { activeKey: 'b' } as ProviderConfig;
    const keys = [
      { label: 'a', apiKey: 'sk-a', createdAt: '' },
      { label: 'b', apiKey: 'sk-b', createdAt: '' },
    ];
    expect(activeLabel(cfg, keys)).toBe('b');
  });

  it('falls back to first key when activeKey is missing from keys', () => {
    const cfg = { activeKey: 'ghost' } as ProviderConfig;
    const keys = [{ label: 'real', apiKey: 'sk-real', createdAt: '' }];
    expect(activeLabel(cfg, keys)).toBe('real');
  });

  it('returns first key label when activeKey is unset', () => {
    const cfg = {} as ProviderConfig;
    const keys = [{ label: 'only', apiKey: 'sk-only', createdAt: '' }];
    expect(activeLabel(cfg, keys)).toBe('only');
  });

  it('returns undefined when there are no keys', () => {
    expect(activeLabel({} as ProviderConfig, [])).toBeUndefined();
  });
});

describe('maskedKey', () => {
  it('shows head + tail for normal-length keys', () => {
    const out = stripAnsi(maskedKey('sk-1234567890abcdef'));
    // head 4 + ellipsis + tail 4 — wrapping varies by color, just check fragments.
    expect(out).toContain('sk-1');
    expect(out).toContain('cdef');
    expect(out).toContain('…');
  });

  it('uses bullets for very short keys (≤8 chars)', () => {
    const out = stripAnsi(maskedKey('short'));
    expect(out).toBe('•••••');
  });

  it('uses bullets at exactly the 8-char boundary', () => {
    const out = stripAnsi(maskedKey('12345678'));
    expect(out).toBe('••••••••');
  });

  it('shows a dim em-dash for empty input', () => {
    expect(stripAnsi(maskedKey(''))).toBe('—');
  });
});

describe('nowIso', () => {
  it('returns a parseable ISO-8601 timestamp', () => {
    const out = nowIso();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isFinite(Date.parse(out))).toBe(true);
  });

  it('returns the current time (within a few seconds of Date.now)', () => {
    const before = Date.now();
    const out = nowIso();
    const after = Date.now();
    const parsed = Date.parse(out);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('normalizeKeys ↔ writeKeysBack roundtrip', () => {
  it('survives a roundtrip without losing data', () => {
    const original: ProviderConfig = {
      activeKey: 'home',
      apiKeys: [
        { label: 'work', apiKey: 'sk-work-123', createdAt: '2026-01-01' },
        { label: 'home', apiKey: 'sk-home-456', createdAt: '2026-02-02' },
      ],
    } as ProviderConfig;
    const keys = normalizeKeys(original);
    const target = { activeKey: 'home' } as ProviderConfig;
    writeKeysBack(target, keys);
    expect(target.apiKeys).toEqual(original.apiKeys);
    expect(target.activeKey).toBe('home');
    // apiKey is cleared — use resolveActiveApiKey to read the real key
    expect(target.apiKey).toBeUndefined();
    expect(resolveActiveApiKey(target)).toBe('sk-home-456');
  });

  it('migrates legacy + writes back as a clean modern shape', () => {
    const legacy: ProviderConfig = { apiKey: 'sk-old' } as ProviderConfig;
    const keys = normalizeKeys(legacy);
    const target = {} as ProviderConfig;
    writeKeysBack(target, keys);
    expect(target.apiKeys).toEqual([{ label: 'default', apiKey: 'sk-old', createdAt: '' }]);
    // apiKey is cleared — use resolveActiveApiKey to read the real key
    expect(target.apiKey).toBeUndefined();
    expect(resolveActiveApiKey(target)).toBe('sk-old');
    expect(target.activeKey).toBe('default');
  });
});
